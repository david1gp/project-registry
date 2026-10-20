import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { cloudflareDnsErrorDetailsRead } from "../cloudflare/cloudflareDnsErrorDetailsRead.js"
import type { CloudflareDnsFetch } from "../cloudflare/CloudflareDnsFetch.js"
import type { CloudflareDnsReconcileResult } from "../cloudflare/CloudflareDnsReconcileResult.js"
import type { CloudflareDnsTrackedRecord } from "../cloudflare/CloudflareDnsTrackedRecord.js"
import { cloudflareDnsDeleteById } from "../cloudflare/cloudflareDnsDeleteById.js"
import { cloudflareDnsReconcile } from "../cloudflare/cloudflareDnsReconcile.js"
import type { Project } from "../project/Project.js"
import { projectCaddyEntries } from "../project/projectCaddyEntries.js"
import { projectDnsPlanCreate } from "../project/projectDnsPlanCreate.js"
import { projectDomainIsCloudflarePages } from "../project/projectDomainIsCloudflarePages.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import type { ProjectKey } from "../project/projectKey.js"
import { projectLocalCaddyEntries } from "../project/projectLocalCaddyEntries.js"
import type { ProjectService } from "../project/projectServiceSchema.js"
import type { ProjectRegistryDaemonCloudflareDnsTracking } from "./ProjectRegistryDaemonCloudflareDnsTracking.js"
import type { ProjectRegistryDaemonCloudflareDnsTrackingState } from "./ProjectRegistryDaemonCloudflareDnsTrackingState.js"
import {
  projectRegistryDaemonCloudflareDnsStatusSchema,
  type ProjectRegistryDaemonCloudflareDnsStatus,
} from "./projectRegistryDaemonCloudflareDnsStatusSchema.js"

const reconcileIntervalMs = 1_000
const retryBaseMs = 1_000
const retryMaximumMs = 60_000
const maxStatusErrors = 20

type ProjectCreateOptions = {
  noDns: boolean
}

type RetryState = {
  attempts: number
  nextAt: number
  sequence: number
}

type ProjectSnapshot = readonly Project[] | undefined

type QueueOutcome = "done" | "deferred" | "failed"

type StatusErrorEntry = {
  owner?: string
  project?: string
  hostname?: string
  recordId?: string
  operation: string
  errorMessage: string
  attempts: number
  occurredAt: number
  nextRetryAt?: number
  statusCode?: number
  cloudflareCode?: number
}

function projectKeyValue(project: ProjectKey): string {
  return `${project.owner}\u0000${project.name}`
}

function projectKeyParse(value: string): ProjectKey {
  const separator = value.indexOf("\u0000")
  if (separator < 0) return { owner: value, name: "" }
  return { owner: value.slice(0, separator), name: value.slice(separator + 1) }
}

function recordKeyValue(record: Pick<CloudflareDnsTrackedRecord, "zoneId" | "id">): string {
  return `${record.zoneId}\u0000${record.id}`
}

function projectKeyEqual(left: ProjectKey, right: ProjectKey): boolean {
  return left.owner === right.owner && left.name === right.name
}

function recordDomainEqual(record: CloudflareDnsTrackedRecord, hostname: string): boolean {
  return projectDomainNormalize(record.name) === hostname
}

function caddyEntryVisibility(caddy: { networkVisibility?: unknown }): "public" | "private" {
  return (caddy as { networkVisibility?: unknown }).networkVisibility === "private" ? "private" : "public"
}

function publicHostnames(project: Project): string[] {
  const values = new Set<string>()
  for (const entry of projectLocalCaddyEntries(project)) {
    if (entry.caddy.disabled) continue
    if (caddyEntryVisibility(entry.caddy) !== "public") continue
    for (const domain of entry.caddy.domains) {
      const normalized = projectDomainNormalize(domain)
      if (normalized !== "") values.add(normalized)
    }
  }
  return [...values]
}

function privateHostnames(project: Project): string[] {
  const values = new Set<string>()
  for (const entry of projectLocalCaddyEntries(project)) {
    if (entry.caddy.disabled) continue
    if (caddyEntryVisibility(entry.caddy) !== "private") continue
    for (const domain of entry.caddy.domains) {
      const normalized = projectDomainNormalize(domain)
      if (normalized !== "") values.add(normalized)
    }
  }
  return [...values]
}

function externalHostnames(project: Project): string[] {
  const values = new Set<string>()
  const externalServiceIds =
    project.schemaVersion === 2
      ? new Set(
          (project.services as readonly ProjectService[])
            .filter((service) => service.ownership === "external")
            .map((service) => service.id),
        )
      : new Set<string>()
  for (const entry of projectCaddyEntries(project)) {
    const external = entry.serviceId !== undefined && externalServiceIds.has(entry.serviceId)
    for (const domain of entry.caddy.domains) {
      const normalized = projectDomainNormalize(domain)
      if (normalized !== "" && (external || projectDomainIsCloudflarePages(normalized))) values.add(normalized)
    }
  }
  return [...values]
}

function projectKeysForHostname(projects: ProjectSnapshot, hostname: string): ProjectKey[] {
  if (projects === undefined) return []
  const keys: ProjectKey[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    if (!publicHostnames(project).includes(hostname)) continue
    const key = { owner: project.owner, name: project.name }
    const value = projectKeyValue(key)
    if (seen.has(value)) continue
    seen.add(value)
    keys.push(key)
  }
  return keys
}

function projectKeysForPrivateHostname(projects: ProjectSnapshot, hostname: string): ProjectKey[] {
  if (projects === undefined) return []
  const keys: ProjectKey[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    if (!privateHostnames(project).includes(hostname)) continue
    const key = { owner: project.owner, name: project.name }
    const value = projectKeyValue(key)
    if (seen.has(value)) continue
    seen.add(value)
    keys.push(key)
  }
  return keys
}

function projectKeysForExternalHostname(projects: ProjectSnapshot, hostname: string): ProjectKey[] {
  if (projects === undefined) return []
  const keys: ProjectKey[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    if (!externalHostnames(project).includes(hostname)) continue
    const key = { owner: project.owner, name: project.name }
    const value = projectKeyValue(key)
    if (seen.has(value)) continue
    seen.add(value)
    keys.push(key)
  }
  return keys
}

function projectKeysEqual(left: readonly ProjectKey[], right: readonly ProjectKey[]): boolean {
  if (left.length !== right.length) return false
  return left.every((key, index) => projectKeyEqual(key, right[index]!))
}

function retryDelay(attempts: number): number {
  return Math.min(retryMaximumMs, retryBaseMs * 2 ** Math.min(attempts, 6))
}

function stateEmpty(): ProjectRegistryDaemonCloudflareDnsTrackingState {
  return { version: 1, records: [] }
}

function stateCopy(
  state: ProjectRegistryDaemonCloudflareDnsTrackingState,
): ProjectRegistryDaemonCloudflareDnsTrackingState {
  return {
    version: state.version,
    records: state.records.map((record) => ({
      ...record,
      projectKeys: record.projectKeys.map((project) => ({ ...project })),
    })),
  }
}

function trackedRecordCreate(
  result: CloudflareDnsReconcileResult,
  projectKeys: readonly ProjectKey[],
): CloudflareDnsTrackedRecord {
  return {
    zoneId: result.zone.id,
    zoneName: result.zone.name,
    id: result.record.id,
    name: result.record.name,
    type: result.record.type,
    content: result.record.content,
    ttl: result.record.ttl,
    proxied: result.record.proxied,
    projectKeys: projectKeys.map((project) => ({ ...project })),
  }
}

function fieldEscape(value: string): string {
  return value.replace(/[\s=]+/g, "_")
}

export function projectRegistryDaemonCloudflareDnsCreate(options: {
  enabled: boolean
  credentialResolve?: (owner: string) => PromiseResult<string | undefined>
  timeoutMs: number
  serverIpCurrent: () => string | undefined
  timer: {
    setInterval(callback: () => void, delayMs: number): unknown
    clearInterval(handle: unknown): void
  }
  fetch?: CloudflareDnsFetch
  logger?: (message: string) => void
  tracking?: ProjectRegistryDaemonCloudflareDnsTracking
  repositoryProjectsCurrent?: () => PromiseResult<readonly Project[]>
  clock?: () => number
}): Result<{
  start(): Result<void>
  shutdown(): PromiseResult<void>
  status(): ProjectRegistryDaemonCloudflareDnsStatus
  projectCreateAfterPersistence(project: Project, options: ProjectCreateOptions): void
  projectEditAfterPersistence(previous: Project, project: Project): void
  projectDeleteAfterPersistence(project: Project): void
}> {
  const op = "projectRegistryDaemonCloudflareDnsCreate"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Cloudflare DNS options are required")
  if (typeof options.enabled !== "boolean") return createResultError(op, "Cloudflare DNS enabled flag is invalid")
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    return createResultError(op, "Cloudflare DNS timeout is invalid")
  }
  if (typeof options.serverIpCurrent !== "function") return createResultError(op, "server IP accessor is required")
  if (options.logger !== undefined && typeof options.logger !== "function") {
    return createResultError(op, "Cloudflare DNS logger is invalid")
  }
  if (options.tracking !== undefined && typeof options.tracking !== "object") {
    return createResultError(op, "Cloudflare DNS tracking is invalid")
  }
  if (options.repositoryProjectsCurrent !== undefined && typeof options.repositoryProjectsCurrent !== "function") {
    return createResultError(op, "Cloudflare DNS project snapshot accessor is invalid")
  }

  const active = options.enabled
  const pendingProjects = new Map<string, RetryState>()
  const desiredProjects = new Map<string, Project>()
  const protectedHostnames = new Map<string, Set<string>>()
  const pendingDeletions = new Map<string, RetryState>()
  const pendingDeletionOwners = new Map<string, string | undefined>()
  const controller = new AbortController()
  const logger = options.logger ?? ((message: string) => console.info(message))
  const clock = options.clock ?? Date.now
  const statusErrors = new Map<string, StatusErrorEntry>()
  const lastLogEvents = new Map<string, string>()
  let state = stateEmpty()
  let trackingBlocked = false
  let lastSuccessAt: number | undefined
  let started = false
  let stopped = false
  let intervalHandle: unknown
  let drainPromise: Promise<void> | undefined
  let forceDrain = false
  let startupPromise: Promise<void> | undefined
  let startupRetry: RetryState | undefined
  let nextSequence = 0
  let shutdownPromise: PromiseResult<void> | undefined

  function log(message: string): void {
    try {
      logger(message)
    } catch {
      // Logging must not affect project mutations or queue shutdown.
    }
  }

  function logEvent(
    event: "reconciliation" | "deletion" | "tracking" | "snapshot" | "credential" | "recovery",
    outcome: "success" | "failure" | "deferred",
    fields: {
      owner?: string
      project?: string
      hostname?: string
      zone?: string
      recordId?: string
      operation?: string
      action?: string
      attempt?: number
      nextRetryMs?: number
      statusCode?: number
      cloudflareCode?: number
      reason?: string
      detail?: string
    },
  ): void {
    const parts = [`cloudflare DNS ${event} outcome=${outcome}`]
    if (fields.owner !== undefined) parts.push(`owner=${fieldEscape(fields.owner)}`)
    if (fields.project !== undefined) parts.push(`project=${fieldEscape(fields.project)}`)
    if (fields.hostname !== undefined) parts.push(`hostname=${fieldEscape(fields.hostname)}`)
    if (fields.zone !== undefined) parts.push(`zone=${fieldEscape(fields.zone)}`)
    if (fields.recordId !== undefined) parts.push(`recordId=${fieldEscape(fields.recordId)}`)
    if (fields.operation !== undefined) parts.push(`operation=${fieldEscape(fields.operation)}`)
    if (fields.action !== undefined) parts.push(`action=${fieldEscape(fields.action)}`)
    if (fields.attempt !== undefined) parts.push(`attempt=${fields.attempt}`)
    if (fields.nextRetryMs !== undefined) parts.push(`nextRetryMs=${fields.nextRetryMs}`)
    if (fields.statusCode !== undefined) parts.push(`status=${fields.statusCode}`)
    if (fields.cloudflareCode !== undefined) parts.push(`cfCode=${fields.cloudflareCode}`)
    if (fields.reason !== undefined) parts.push(`reason=${fieldEscape(fields.reason)}`)
    if (fields.detail !== undefined) parts.push(`detail=${fieldEscape(fields.detail)}`)
    const message = parts.join(" ")
    const key = [event, fields.owner, fields.project, fields.hostname, fields.recordId].join("\u0000")
    const alreadyReported = [...statusErrors.values()].some(
      (entry) =>
        entry.owner === fields.owner &&
        entry.project === fields.project &&
        entry.hostname === fields.hostname &&
        entry.recordId === fields.recordId,
    )
    if (lastLogEvents.get(key) === message && (outcome === "success" || alreadyReported)) return
    lastLogEvents.delete(key)
    lastLogEvents.set(key, message)
    if (lastLogEvents.size > 1000) lastLogEvents.delete(lastLogEvents.keys().next().value!)
    log(message)
  }

  function statusErrorKey(
    entry: Pick<StatusErrorEntry, "operation" | "owner" | "project" | "hostname" | "recordId">,
  ): string {
    return [entry.operation, entry.owner ?? "", entry.project ?? "", entry.hostname ?? "", entry.recordId ?? ""].join(
      "\u0000",
    )
  }

  function statusErrorUpsert(entry: StatusErrorEntry): void {
    statusErrors.set(statusErrorKey(entry), { ...entry })
    while (statusErrors.size > maxStatusErrors) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, value] of statusErrors) {
        if (value.occurredAt < oldestAt) {
          oldestAt = value.occurredAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      statusErrors.delete(oldestKey)
    }
  }

  function statusErrorsClear(predicate: (entry: StatusErrorEntry) => boolean): void {
    for (const [key, value] of [...statusErrors]) {
      if (predicate(value)) statusErrors.delete(key)
    }
  }

  function successRecord(): void {
    lastSuccessAt = clock()
  }

  function successClearHostname(hostname: string, owner?: string, project?: string): void {
    statusErrorsClear(
      (entry) =>
        entry.hostname === hostname &&
        (owner === undefined || entry.owner === owner) &&
        (project === undefined || entry.project === project),
    )
  }

  function successClearRecord(recordId: string): void {
    statusErrorsClear((entry) => entry.recordId === recordId)
  }

  function successClearOperation(operation: string): void {
    statusErrorsClear((entry) => entry.operation === operation)
  }

  function successClearProject(owner: string, project: string): void {
    statusErrorsClear(
      (entry) =>
        entry.owner === owner &&
        entry.project === project &&
        entry.hostname === undefined &&
        entry.recordId === undefined,
    )
  }

  function deletionStateRetry(key: string): RetryState {
    return pendingDeletions.get(key) ?? { attempts: 0, nextAt: 0, sequence: nextSequence++ }
  }

  function retryProject(key: string, retry: RetryState, deferred: boolean): void {
    const attempts = deferred ? retry.attempts : retry.attempts + 1
    pendingProjects.delete(key)
    pendingProjects.set(key, {
      attempts,
      nextAt: clock() + (deferred ? retryBaseMs : retryDelay(attempts)),
      sequence: retry.sequence,
    })
  }

  function retryDeletion(key: string): { attempts: number; nextRetryMs: number } {
    const retry = deletionStateRetry(key)
    const attempts = retry.attempts + 1
    const nextRetryMs = retryDelay(attempts)
    pendingDeletions.set(key, { attempts, nextAt: clock() + nextRetryMs, sequence: retry.sequence })
    return { attempts, nextRetryMs }
  }

  function deletionOwnerSet(key: string, projectKeys: readonly ProjectKey[]): string | undefined {
    const owners = [...new Set(projectKeys.map((project) => project.owner))]
    if (owners.length !== 1) return undefined
    pendingDeletionOwners.set(key, owners[0])
    return owners[0]
  }

  function deletionSchedule(key: string, projectKeys: readonly ProjectKey[]): void {
    if (deletionOwnerSet(key, projectKeys) === undefined) {
      deletionPendingClear(key)
      return
    }
    pendingDeletions.set(key, deletionStateRetry(key))
  }

  function deletionPendingClear(key: string): void {
    pendingDeletions.delete(key)
    pendingDeletionOwners.delete(key)
  }

  function deletionOwnerOf(record: CloudflareDnsTrackedRecord): string | undefined {
    const owners = [...new Set(record.projectKeys.map((project) => project.owner))]
    if (owners.length === 1) return owners[0]
    return pendingDeletionOwners.get(recordKeyValue(record))
  }

  function runIsCurrent(keyValue: string, sequence: number): boolean {
    return pendingProjects.get(keyValue)?.sequence === sequence
  }

  async function tokenForOwner(owner: string): Promise<Result<string | undefined>> {
    if (options.credentialResolve === undefined) return createResult(undefined)
    try {
      const result = await options.credentialResolve(owner)
      if (typeof result !== "object" || result === null || typeof result.success !== "boolean") {
        return createResultError(
          "projectRegistryDaemonCloudflareDnsCredentialResolve",
          "Cloudflare credentials could not be loaded",
        )
      }
      if (!result.success)
        return createResultError(
          "projectRegistryDaemonCloudflareDnsCredentialResolve",
          "Cloudflare credentials could not be loaded",
        )
      if (
        result.data !== undefined &&
        (typeof result.data !== "string" || result.data.length === 0 || result.data.trim() !== result.data)
      ) {
        return createResultError(
          "projectRegistryDaemonCloudflareDnsCredentialResolve",
          "Cloudflare credentials are invalid",
        )
      }
      return createResult(result.data)
    } catch {
      return createResultError(
        "projectRegistryDaemonCloudflareDnsCredentialResolve",
        "Cloudflare credentials could not be loaded",
      )
    }
  }

  function pendingDue(retry: RetryState): boolean {
    return retry.nextAt <= clock()
  }

  function intervalEnsure(): void {
    if (!active || stopped || intervalHandle !== undefined) return
    try {
      intervalHandle = options.timer.setInterval(() => {
        if (options.repositoryProjectsCurrent === undefined) {
          drainSchedule(true)
          return
        }
        void recurringReconcile()
      }, reconcileIntervalMs)
    } catch {
      logEvent("reconciliation", "failure", { operation: "timer", reason: "retry-timer-unavailable" })
      statusErrorUpsert({
        operation: "timer",
        errorMessage: "DNS retry timer unavailable",
        attempts: 0,
        occurredAt: clock(),
      })
    }
  }

  function startupRetrySchedule(): void {
    const attempts = (startupRetry?.attempts ?? 0) + 1
    startupRetry = {
      attempts,
      nextAt: clock() + retryDelay(attempts),
      sequence: startupRetry?.sequence ?? nextSequence++,
    }
  }

  async function currentProjects(): Promise<Result<ProjectSnapshot>> {
    if (options.repositoryProjectsCurrent === undefined) return createResult(undefined)
    try {
      const result = await options.repositoryProjectsCurrent()
      if (!result.success) {
        logEvent("snapshot", "failure", { reason: "repository-snapshot-unavailable" })
        statusErrorUpsert({
          operation: "snapshot",
          errorMessage: "repository-snapshot-unavailable",
          attempts: 0,
          occurredAt: clock(),
        })
        return createResultError("projectRegistryDaemonCloudflareDnsSnapshot", result.errorMessage)
      }
      successClearOperation("snapshot")
      return createResult(result.data)
    } catch {
      logEvent("snapshot", "failure", { reason: "repository-snapshot-unavailable" })
      statusErrorUpsert({
        operation: "snapshot",
        errorMessage: "repository-snapshot-unavailable",
        attempts: 0,
        occurredAt: clock(),
      })
      return createResultError("projectRegistryDaemonCloudflareDnsSnapshot", "repository snapshot failed")
    }
  }

  async function recurringReconcile(): Promise<void> {
    if (!active || !started || stopped) return
    const projectsR = await currentProjects()
    if (!projectsR.success || projectsR.data === undefined) {
      drainSchedule(true)
      return
    }

    for (const project of projectsR.data) {
      const key = projectKeyValue(project)
      desiredProjects.set(key, project)
      if (!pendingProjects.has(key)) pendingProjects.set(key, { attempts: 0, nextAt: 0, sequence: nextSequence++ })
    }
    drainSchedule(true)
  }

  async function trackingStateWrite(next: ProjectRegistryDaemonCloudflareDnsTrackingState): Promise<boolean> {
    if (options.tracking === undefined) {
      state = next
      return true
    }
    if (trackingBlocked || stopped) return false
    try {
      const result = await options.tracking.write(next)
      if (!result.success) {
        logEvent("tracking", "failure", { operation: "write", reason: "tracking-write-failed" })
        statusErrorUpsert({
          operation: "tracking",
          errorMessage: "tracking-write-failed",
          attempts: 0,
          occurredAt: clock(),
        })
        return false
      }
      if (stopped) return false
      state = next
      successClearOperation("tracking")
      return true
    } catch {
      logEvent("tracking", "failure", { operation: "write", reason: "tracking-write-failed" })
      statusErrorUpsert({
        operation: "tracking",
        errorMessage: "tracking-write-failed",
        attempts: 0,
        occurredAt: clock(),
      })
      return false
    }
  }

  async function trackingStateInitialize(): Promise<void> {
    if (options.tracking === undefined) return
    let readR: Awaited<ReturnType<ProjectRegistryDaemonCloudflareDnsTracking["read"]>>
    try {
      readR = await options.tracking.read()
    } catch {
      trackingBlocked = true
      logEvent("tracking", "failure", { operation: "read", reason: "tracking-read-failed" })
      statusErrorUpsert({
        operation: "tracking",
        errorMessage: "tracking-read-failed",
        attempts: 0,
        occurredAt: clock(),
      })
      return
    }
    if (!readR.success) {
      trackingBlocked = true
      logEvent("tracking", "failure", { operation: "read", reason: "tracking-read-failed" })
      statusErrorUpsert({
        operation: "tracking",
        errorMessage: "tracking-read-failed",
        attempts: 0,
        occurredAt: clock(),
      })
      return
    }
    state = readR.data
    successClearOperation("tracking")
    if (stopped) return

    const projectsR = await currentProjects()
    if (!projectsR.success || stopped) {
      if (!stopped) startupRetrySchedule()
      return
    }
    const projects = projectsR.data
    if (projects === undefined) {
      return
    }

    const next = stateCopy(state)
    const deletionOwners = new Map<string, ProjectKey[]>()
    let changed = false
    const planR = projectDnsPlanCreate(projects)
    if (!planR.success) {
      logEvent("tracking", "deferred", {
        operation: "startup",
        reason: "conflicting-public-private-claims",
      })
      statusErrorUpsert({
        operation: "startup",
        errorMessage: "conflicting-public-private-claims",
        attempts: startupRetry?.attempts ?? 0,
        occurredAt: clock(),
      })
      startupRetrySchedule()
      return
    }
    for (const record of next.records) {
      const hostname = projectDomainNormalize(record.name)
      const projectKeys = projectKeysForHostname(projects, hostname)
      const externalProjectKeys = projectKeysForExternalHostname(projects, hostname)
      const privateProjectKeys = projectKeysForPrivateHostname(projects, hostname)
      if (projectKeys.length > 0 && privateProjectKeys.length > 0) continue
      if (projectDomainIsCloudflarePages(hostname)) {
        next.records = next.records.filter((entry) => recordKeyValue(entry) !== recordKeyValue(record))
        changed = true
        continue
      }
      if (projectKeys.length === 0 && externalProjectKeys.length > 0) {
        next.records = next.records.filter((entry) => recordKeyValue(entry) !== recordKeyValue(record))
        changed = true
        continue
      }
      if (projectKeysEqual(record.projectKeys, projectKeys)) continue
      if (projectKeys.length === 0 && record.projectKeys.length === 1) {
        deletionOwners.set(
          recordKeyValue(record),
          record.projectKeys.map((project) => ({ ...project })),
        )
        continue
      }
      if (projectKeys.length === 0) continue
      record.projectKeys = projectKeys
      changed = true
    }
    if (changed && !(await trackingStateWrite(next))) {
      startupRetrySchedule()
      return
    }
    if (changed) {
      successRecord()
      logEvent("recovery", "success", { operation: "startup", detail: "stale-tracking-reconciled" })
    }
    successClearOperation("startup")
    startupRetry = undefined
    // Orphan deletions stay scheduled until their owning projects finish
    // reconciling replacements; the deletion path defers while an owner has
    // pending project work so a restart during a failed rename cannot remove
    // the old record before the replacement exists.
    for (const [recordKey, projectKeys] of deletionOwners) {
      deletionSchedule(recordKey, projectKeys)
    }
    if (pendingDeletions.size > 0) intervalEnsure()
  }

  function trackingRecordFind(hostname: string, project?: ProjectKey): CloudflareDnsTrackedRecord | undefined {
    return state.records.find(
      (record) =>
        recordDomainEqual(record, hostname) &&
        (project === undefined || record.projectKeys.some((key) => projectKeyEqual(key, project))),
    )
  }

  async function trackingRecordOwnersSet(
    record: CloudflareDnsTrackedRecord,
    projectKeys: readonly ProjectKey[],
  ): Promise<boolean> {
    if (projectKeysEqual(record.projectKeys, projectKeys)) return true
    const next = stateCopy(state)
    const current = next.records.find((entry) => recordKeyValue(entry) === recordKeyValue(record))
    if (current === undefined) return true
    current.projectKeys = projectKeys.map((project) => ({ ...project }))
    return trackingStateWrite(next)
  }

  async function trackingRecordRelease(record: CloudflareDnsTrackedRecord): Promise<boolean> {
    const next = stateCopy(state)
    next.records = next.records.filter((entry) => recordKeyValue(entry) !== recordKeyValue(record))
    const written = await trackingStateWrite(next)
    if (written) deletionPendingClear(recordKeyValue(record))
    return written
  }

  function currentOwners(
    record: CloudflareDnsTrackedRecord,
    project: ProjectKey,
    projects: ProjectSnapshot,
  ): ProjectKey[] {
    if (projects !== undefined) {
      return projectKeysForHostname(projects, projectDomainNormalize(record.name)).filter(
        (key) => !projectKeyEqual(key, project),
      )
    }
    return record.projectKeys.filter((key) => !projectKeyEqual(key, project))
  }

  type DeletionExpectation = { keyValue: string; sequence: number; project?: Project }

  function projectDnsSignature(project: Project | undefined): string {
    if (project === undefined) return "deleted"
    return JSON.stringify([
      publicHostnames(project).sort(),
      privateHostnames(project).sort(),
      externalHostnames(project).sort(),
    ])
  }

  async function deletionAllowed(
    record: CloudflareDnsTrackedRecord,
    expected?: DeletionExpectation,
  ): PromiseResult<boolean> {
    if (stopped) return createResult(false)
    const freshR = await currentProjects()
    if (!freshR.success) return createResultError(op, "DNS deletion deferred: repository snapshot unavailable")
    const projects = freshR.data ?? [...desiredProjects.values()]
    const hostname = projectDomainNormalize(record.name)
    if (!projectDnsPlanCreate(projects).success) return createResult(false)
    if (
      projectKeysForHostname(projects, hostname).length > 0 ||
      projectKeysForExternalHostname(projects, hostname).length > 0
    )
      return createResult(false)
    if (expected !== undefined) {
      if (!runIsCurrent(expected.keyValue, expected.sequence)) return createResult(false)
      const latest = projects.find((project) => projectKeyValue(project) === expected.keyValue)
      if (projectDnsSignature(latest) !== projectDnsSignature(expected.project)) {
        if (latest !== undefined) projectQueueSet(latest)
        return createResult(false)
      }
    }
    for (const key of record.projectKeys) {
      const keyValue = projectKeyValue(key)
      if (pendingProjects.has(keyValue) && keyValue !== expected?.keyValue) return createResult(false)
      const latest = projects.find((project) => projectKeyValue(project) === keyValue)
      if (latest === undefined) continue
      if (publicHostnames(latest).some((target) => trackingRecordFind(target, key) === undefined)) {
        projectQueueSet(latest)
        return createResult(false)
      }
    }
    return createResult(!stopped)
  }

  async function deletionAttempt(
    recordKey: string,
    projects: ProjectSnapshot,
    expected?: DeletionExpectation,
  ): Promise<QueueOutcome> {
    const record = state.records.find((entry) => recordKeyValue(entry) === recordKey)
    if (record === undefined) {
      deletionPendingClear(recordKey)
      return "done"
    }
    const hostname = projectDomainNormalize(record.name)
    if (projectDomainIsCloudflarePages(hostname)) {
      if (!(await trackingRecordRelease(record))) return "failed"
      successRecord()
      logEvent("recovery", "success", {
        hostname,
        recordId: record.id,
        operation: "record-delete",
        detail: "released-pages-dev",
      })
      return "done"
    }
    // Revalidate against the latest snapshot before touching DNS: a concurrent
    // edit may have reclaimed this hostname for the same or another project.
    const claimants = projectKeysForHostname(projects, hostname)
    if (claimants.length > 0) {
      if (!(await trackingRecordOwnersSet(record, claimants))) return "failed"
      deletionPendingClear(recordKey)
      successRecord()
      // Reassigning ownership does not mean the new claimant's DNS attempt
      // succeeded; only its own reconciliation may clear hostname failures.
      successClearRecord(record.id)
      logEvent("recovery", "success", {
        hostname,
        recordId: record.id,
        operation: "record-delete",
        detail: "hostname-reclaimed",
      })
      return "done"
    }
    if (projectKeysForExternalHostname(projects, hostname).length > 0) {
      if (!(await trackingRecordRelease(record))) return "failed"
      successRecord()
      logEvent("recovery", "success", {
        hostname,
        recordId: record.id,
        operation: "record-delete",
        detail: "released-external",
      })
      return "done"
    }
    const deletionOwner = deletionOwnerOf(record)
    if (deletionOwner === undefined) {
      deletionPendingClear(recordKey)
      return "done"
    }
    const tokenR = await tokenForOwner(deletionOwner)
    if (!tokenR.success) {
      const { attempts, nextRetryMs } = retryDeletion(recordKey)
      logEvent("credential", "deferred", {
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        attempt: attempts,
        nextRetryMs,
        reason:
          tokenR.errorMessage === "Cloudflare credentials are invalid"
            ? "owner-credential-invalid"
            : "owner-credential-unavailable",
      })
      statusErrorUpsert({
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        operation: "delete",
        errorMessage:
          tokenR.errorMessage === "Cloudflare credentials are invalid"
            ? "owner-credential-invalid"
            : "owner-credential-unavailable",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
      })
      return "failed"
    }
    if (tokenR.data === undefined) {
      const { attempts, nextRetryMs } = retryDeletion(recordKey)
      logEvent("credential", "deferred", {
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        attempt: attempts,
        nextRetryMs,
        reason: "owner-credential-missing",
      })
      statusErrorUpsert({
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        operation: "delete",
        errorMessage: "owner-credential-missing",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
      })
      return "failed"
    }
    let deleteR: Awaited<ReturnType<typeof cloudflareDnsDeleteById>>
    try {
      deleteR = await cloudflareDnsDeleteById({
        token: tokenR.data,
        record,
        beforeDelete: () => deletionAllowed(record, expected),
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    } catch {
      const { attempts, nextRetryMs } = retryDeletion(recordKey)
      logEvent("deletion", "failure", {
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        operation: "record-delete",
        attempt: attempts,
        nextRetryMs,
        reason: "cloudflare-request-failed",
      })
      statusErrorUpsert({
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        operation: "delete",
        errorMessage: "cloudflare-request-failed",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
      })
      return "failed"
    }
    if (!deleteR.success) {
      const details = cloudflareDnsErrorDetailsRead(deleteR)
      const { attempts, nextRetryMs } = retryDeletion(recordKey)
      logEvent("deletion", "failure", {
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        operation: details.operation ?? "record-delete",
        attempt: attempts,
        nextRetryMs,
        ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
        ...(details.cloudflareCode === undefined ? {} : { cloudflareCode: details.cloudflareCode }),
        reason: deleteR.errorMessage,
      })
      statusErrorUpsert({
        owner: deletionOwner,
        hostname,
        recordId: record.id,
        operation: details.operation ?? "record-delete",
        errorMessage: deleteR.errorMessage,
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
        ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
        ...(details.cloudflareCode === undefined ? {} : { cloudflareCode: details.cloudflareCode }),
      })
      return "failed"
    }
    if (stopped) return "done"
    const next = stateCopy(state)
    next.records = next.records.filter((entry) => recordKeyValue(entry) !== recordKeyValue(record))
    if (!(await trackingStateWrite(next))) {
      retryDeletion(recordKey)
      return "failed"
    }
    deletionPendingClear(recordKey)
    successRecord()
    successClearHostname(hostname)
    successClearRecord(record.id)
    logEvent("deletion", "success", {
      owner: deletionOwner,
      hostname,
      zone: record.zoneName,
      recordId: record.id,
      operation: "record-delete",
      action: deleteR.data.action,
    })
    return "done"
  }

  async function trackedRecordDeletionRun(recordKey: string): Promise<QueueOutcome> {
    const record = state.records.find((entry) => recordKeyValue(entry) === recordKey)
    if (record === undefined) {
      deletionPendingClear(recordKey)
      return "done"
    }
    if (projectDomainIsCloudflarePages(record.name)) {
      return (await trackingRecordRelease(record)) ? "done" : "failed"
    }
    if (record.projectKeys.length > 0 && !pendingDeletionOwners.has(recordKey)) {
      deletionPendingClear(recordKey)
      return "done"
    }
    // An owner with pending project work may still reconcile a replacement
    // hostname; wait for that run instead of deleting based on stale state.
    if (record.projectKeys.some((key) => pendingProjects.has(projectKeyValue(key)))) {
      const retry = deletionStateRetry(recordKey)
      pendingDeletions.set(recordKey, {
        attempts: retry.attempts,
        nextAt: clock() + retryBaseMs,
        sequence: retry.sequence,
      })
      return "failed"
    }
    const projectsR = await currentProjects()
    const outcome =
      !projectsR.success && options.repositoryProjectsCurrent !== undefined
        ? "failed"
        : await deletionAttempt(recordKey, projectsR.success ? projectsR.data : undefined)
    if (outcome === "failed" && pendingDeletions.has(recordKey) && pendingDue(pendingDeletions.get(recordKey)!))
      retryDeletion(recordKey)
    return outcome
  }

  async function projectOwnershipReconcile(
    project: Project,
    projects: ProjectSnapshot,
    previousExcludedHostnames: ReadonlySet<string>,
    orphans: string[],
  ): Promise<QueueOutcome> {
    const key = { owner: project.owner, name: project.name }
    const currentDomains = new Set(publicHostnames(project))
    const currentPrivateHostnames = new Set(privateHostnames(project))
    const currentExcludedHostnames = new Set(externalHostnames(project))
    const recordsToRemove = state.records.filter(
      (record) =>
        record.projectKeys.some((projectKey) => projectKeyEqual(projectKey, key)) &&
        !currentDomains.has(projectDomainNormalize(record.name)),
    )
    for (const record of recordsToRemove) {
      if (stopped) return "done"
      const hostname = projectDomainNormalize(record.name)
      const owners = currentOwners(record, key, projects)
      if (projectDomainIsCloudflarePages(hostname)) {
        if (owners.length === 0) {
          if (!(await trackingRecordRelease(record))) return "failed"
        } else if (!(await trackingRecordOwnersSet(record, owners))) {
          return "failed"
        }
        continue
      }
      if (
        previousExcludedHostnames.has(hostname) ||
        currentExcludedHostnames.has(hostname) ||
        projectKeysForExternalHostname(projects, hostname).length > 0
      ) {
        if (owners.length === 0) {
          if (!(await trackingRecordRelease(record))) return "failed"
        } else if (!(await trackingRecordOwnersSet(record, owners))) {
          return "failed"
        }
        continue
      }
      if (currentPrivateHostnames.has(hostname)) {
        if (owners.length === 0) {
          // Verified deletion runs only after this project's public
          // replacements reconcile; schedule here, delete later.
          deletionSchedule(recordKeyValue(record), record.projectKeys)
          orphans.push(recordKeyValue(record))
          continue
        }
        if (!(await trackingRecordOwnersSet(record, owners))) return "failed"
        continue
      }
      if (owners.length === 0) {
        // Create-before-delete: keep the old record until every public
        // replacement for this project reconciles and persists.
        deletionSchedule(recordKeyValue(record), record.projectKeys)
        orphans.push(recordKeyValue(record))
        continue
      }
      if (!(await trackingRecordOwnersSet(record, owners))) return "failed"
    }

    for (const hostname of currentDomains) {
      const record = trackingRecordFind(hostname)
      if (record === undefined) continue
      const snapshotOwners = projects === undefined ? [] : projectKeysForHostname(projects, hostname)
      const owners =
        projects === undefined
          ? [...record.projectKeys, ...(record.projectKeys.some((entry) => projectKeyEqual(entry, key)) ? [] : [key])]
          : [...snapshotOwners, ...(snapshotOwners.some((entry) => projectKeyEqual(entry, key)) ? [] : [key])]
      const uniqueOwners = owners.filter(
        (entry, index) => owners.findIndex((candidate) => projectKeyEqual(candidate, entry)) === index,
      )
      if (!(await trackingRecordOwnersSet(record, uniqueOwners))) return "failed"
      deletionPendingClear(recordKeyValue(record))
    }
    return "done"
  }

  async function projectRemoteReconcile(
    project: Project,
    projects: ProjectSnapshot,
    attempts: number,
  ): Promise<QueueOutcome> {
    const projectKey = { owner: project.owner, name: project.name }
    const hostnames = publicHostnames(project)
    if (hostnames.length === 0) return "done"
    const address = options.serverIpCurrent()
    if (address === undefined || address === "") {
      logEvent("reconciliation", "deferred", {
        owner: project.owner,
        project: project.name,
        attempt: attempts,
        nextRetryMs: retryBaseMs,
        reason: "server-ip-unavailable",
      })
      statusErrorUpsert({
        owner: project.owner,
        project: project.name,
        operation: "reconcile",
        errorMessage: "server-ip-unavailable",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + retryBaseMs,
      })
      return "deferred"
    }
    const tokenR = await tokenForOwner(project.owner)
    if (!tokenR.success) {
      logEvent("credential", "deferred", {
        owner: project.owner,
        project: project.name,
        attempt: attempts,
        nextRetryMs: retryBaseMs,
        reason:
          tokenR.errorMessage === "Cloudflare credentials are invalid"
            ? "owner-credential-invalid"
            : "owner-credential-unavailable",
      })
      statusErrorUpsert({
        owner: project.owner,
        project: project.name,
        operation: "reconcile",
        errorMessage:
          tokenR.errorMessage === "Cloudflare credentials are invalid"
            ? "owner-credential-invalid"
            : "owner-credential-unavailable",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + retryBaseMs,
      })
      return "deferred"
    }
    if (tokenR.data === undefined) {
      logEvent("credential", "deferred", {
        owner: project.owner,
        project: project.name,
        attempt: attempts,
        nextRetryMs: retryBaseMs,
        reason: "owner-credential-missing",
      })
      statusErrorUpsert({
        owner: project.owner,
        project: project.name,
        operation: "reconcile",
        errorMessage: "owner-credential-missing",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + retryBaseMs,
      })
      return "deferred"
    }
    let allOk = true
    for (const hostname of hostnames) {
      if (stopped) return "done"
      let reconcileR: Awaited<ReturnType<typeof cloudflareDnsReconcile>>
      try {
        reconcileR = await cloudflareDnsReconcile({
          token: tokenR.data,
          hostname,
          address,
          timeoutMs: options.timeoutMs,
          signal: controller.signal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        })
      } catch {
        allOk = false
        logEvent("reconciliation", "failure", {
          owner: project.owner,
          project: project.name,
          hostname,
          operation: "request",
          attempt: attempts + 1,
          nextRetryMs: retryDelay(attempts + 1),
          reason: "cloudflare-request-failed",
        })
        statusErrorUpsert({
          owner: project.owner,
          project: project.name,
          hostname,
          operation: "request",
          errorMessage: "cloudflare-request-failed",
          attempts: attempts + 1,
          occurredAt: clock(),
          nextRetryAt: clock() + retryDelay(attempts + 1),
        })
        continue
      }
      if (!reconcileR.success) {
        allOk = false
        const details = cloudflareDnsErrorDetailsRead(reconcileR)
        logEvent("reconciliation", "failure", {
          owner: project.owner,
          project: project.name,
          hostname,
          operation: details.operation ?? "request",
          attempt: attempts + 1,
          nextRetryMs: retryDelay(attempts + 1),
          ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
          ...(details.cloudflareCode === undefined ? {} : { cloudflareCode: details.cloudflareCode }),
          reason: reconcileR.errorMessage,
        })
        statusErrorUpsert({
          owner: project.owner,
          project: project.name,
          hostname,
          operation: details.operation ?? "request",
          errorMessage: reconcileR.errorMessage,
          attempts: attempts + 1,
          occurredAt: clock(),
          nextRetryAt: clock() + retryDelay(attempts + 1),
          ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
          ...(details.cloudflareCode === undefined ? {} : { cloudflareCode: details.cloudflareCode }),
        })
        continue
      }
      if (stopped) return "done"
      const existing = state.records.find(
        (record) => record.zoneId === reconcileR.data.zone.id && record.id === reconcileR.data.record.id,
      )
      const snapshotOwners = projects === undefined ? [] : projectKeysForHostname(projects, hostname)
      const projectKeys =
        projects === undefined
          ? [...(existing?.projectKeys ?? []), projectKey]
          : [
              ...snapshotOwners,
              ...(snapshotOwners.some((entry) => projectKeyEqual(entry, projectKey)) ? [] : [projectKey]),
            ]
      const uniqueOwners = projectKeys.filter(
        (entry, index) => projectKeys.findIndex((candidate) => projectKeyEqual(candidate, entry)) === index,
      )
      const next = stateCopy(state)
      const tracked = trackedRecordCreate(reconcileR.data, uniqueOwners)
      const index = next.records.findIndex((record) => recordKeyValue(record) === recordKeyValue(tracked))
      if (index < 0) next.records.push(tracked)
      else next.records[index] = tracked
      if (!(await trackingStateWrite(next))) {
        allOk = false
        continue
      }
      deletionPendingClear(recordKeyValue(tracked))
      const recovered = [...statusErrors.values()].some(
        (entry) =>
          entry.owner === project.owner &&
          entry.project === project.name &&
          (entry.hostname === undefined || entry.hostname === hostname),
      )
      successClearHostname(hostname, project.owner, project.name)
      successClearProject(project.owner, project.name)
      successRecord()
      if (reconcileR.data.action !== "skipped" || recovered) {
        logEvent("reconciliation", "success", {
          owner: project.owner,
          project: project.name,
          hostname,
          zone: reconcileR.data.zone.name,
          recordId: reconcileR.data.record.id,
          operation: "record-reconcile",
          action: reconcileR.data.action,
        })
      }
    }
    return allOk ? "done" : "failed"
  }

  async function projectRun(keyValue: string, sequence: number): Promise<QueueOutcome> {
    const requested = desiredProjects.get(keyValue)
    if (!active) {
      if (pendingProjects.get(keyValue)?.sequence === sequence) pendingProjects.delete(keyValue)
      return "done"
    }
    const projectsR = await currentProjects()
    if (!projectsR.success && options.repositoryProjectsCurrent !== undefined) return "failed"
    const projects = projectsR.success ? projectsR.data : undefined
    if (projects !== undefined) {
      const planR = projectDnsPlanCreate(projects)
      if (!planR.success) {
        logEvent("reconciliation", "failure", {
          reason: "conflicting-public-private-claims",
        })
        statusErrorUpsert({
          operation: "reconcile",
          errorMessage: "conflicting-public-private-claims",
          attempts: pendingProjects.get(keyValue)?.attempts ?? 0,
          occurredAt: clock(),
        })
        return "failed"
      }
      statusErrorsClear(
        (entry) => entry.owner === undefined && entry.errorMessage === "conflicting-public-private-claims",
      )
    }
    const desired =
      projects === undefined || requested === undefined
        ? requested
        : projects.find((project) => projectKeyValue(project) === keyValue)
    if (desired === undefined) {
      if (projectsR.success && projects === undefined && options.repositoryProjectsCurrent !== undefined)
        return "failed"
      if (options.tracking !== undefined) {
        const projectKey = projectKeyParse(keyValue)
        const outcome = await projectOrphansCleanup(projectKey, keyValue, sequence, projects)
        if (outcome !== "done") return outcome
      }
      const deletedKey = projectKeyParse(keyValue)
      statusErrorsClear((entry) => entry.owner === deletedKey.owner && entry.project === deletedKey.name)
      if (pendingProjects.get(keyValue)?.sequence === sequence) pendingProjects.delete(keyValue)
      return "done"
    }

    if (options.tracking !== undefined) {
      const orphans: string[] = []
      const ownershipOutcome = await projectOwnershipReconcile(
        desired,
        projects,
        protectedHostnames.get(keyValue) ?? new Set<string>(),
        orphans,
      )
      if (ownershipOutcome !== "done") return ownershipOutcome
      const attempts = pendingProjects.get(keyValue)?.attempts ?? 0
      const remoteOutcome = await projectRemoteReconcile(desired, projects, attempts)
      if (remoteOutcome !== "done") {
        // A failing or partial replacement must leave the old DNS records in
        // place; orphan deletions run only after every public hostname
        // reconciles and persists.
        return remoteOutcome
      }
      // No public replacements means no server IP is needed. Otherwise every
      // replacement is durably tracked before cleanup can pass its final guard.
      if (!runIsCurrent(keyValue, sequence)) return "done"
      const cleanupOutcome = await projectOrphansAttempt(orphans, keyValue, sequence, desired)
      if (cleanupOutcome !== "done") return cleanupOutcome
    } else {
      const attempts = pendingProjects.get(keyValue)?.attempts ?? 0
      const remoteOutcome = await projectRemoteReconcile(desired, projects, attempts)
      if (remoteOutcome !== "done") return remoteOutcome
    }
    if (runIsCurrent(keyValue, sequence)) {
      statusErrorsClear((entry) => entry.owner === desired.owner && entry.project === desired.name)
      protectedHostnames.delete(keyValue)
      pendingProjects.delete(keyValue)
    }
    return "done"
  }

  async function projectOrphansAttempt(
    orphans: string[],
    keyValue: string,
    sequence: number,
    project?: Project,
  ): Promise<QueueOutcome> {
    if (orphans.length === 0) return "done"
    const freshR = await currentProjects()
    if (!freshR.success && options.repositoryProjectsCurrent !== undefined) return "failed"
    const fresh = freshR.success ? freshR.data : undefined
    let allOk = true
    for (const orphanKey of orphans) {
      if (stopped) return "done"
      if (!runIsCurrent(keyValue, sequence)) return "done"
      const outcome = await deletionAttempt(orphanKey, fresh, { keyValue, sequence, project })
      if (outcome !== "done") {
        allOk = false
        if (pendingDeletions.has(orphanKey) && pendingDue(pendingDeletions.get(orphanKey)!)) retryDeletion(orphanKey)
      }
    }
    return allOk ? "done" : "failed"
  }

  async function projectOrphansCleanup(
    projectKey: ProjectKey,
    keyValue: string,
    sequence: number,
    projects: ProjectSnapshot,
  ): Promise<QueueOutcome> {
    const records = state.records.filter((record) => record.projectKeys.some((key) => projectKeyEqual(key, projectKey)))
    const orphans: string[] = []
    for (const record of records) {
      if (stopped) return "done"
      const hostname = projectDomainNormalize(record.name)
      const owners = currentOwners(record, projectKey, projects)
      if (
        protectedHostnames.get(keyValue)?.has(hostname) === true ||
        projectDomainIsCloudflarePages(hostname) ||
        projectKeysForExternalHostname(projects, hostname).length > 0
      ) {
        if (owners.length === 0) {
          if (!(await trackingRecordRelease(record))) return "failed"
        } else if (!(await trackingRecordOwnersSet(record, owners))) {
          return "failed"
        }
        continue
      }
      if (owners.length === 0) {
        deletionSchedule(recordKeyValue(record), record.projectKeys.length === 0 ? [projectKey] : record.projectKeys)
        orphans.push(recordKeyValue(record))
        continue
      }
      if (!(await trackingRecordOwnersSet(record, owners))) return "failed"
    }
    // Project deletion and projects without public replacements clean up
    // without waiting for the server IP.
    return projectOrphansAttempt(orphans, keyValue, sequence)
  }

  async function drain(force: boolean): Promise<void> {
    if (!started || stopped || (!active && options.tracking === undefined)) return
    if (startupPromise !== undefined) await startupPromise
    if (stopped || trackingBlocked) return
    const forcedProjects = new Set<string>()

    while (!stopped) {
      if (startupRetry !== undefined && pendingDue(startupRetry)) {
        startupRetry = undefined
        await trackingStateInitialize()
        if (startupRetry !== undefined || trackingBlocked) return
      }
      const dueDeletion = [...pendingDeletions.entries()].find(([, retry]) => pendingDue(retry))
      const dueProject = [...pendingProjects.entries()].find(
        ([key, retry]) =>
          pendingDue(retry) ||
          (force &&
            !forcedProjects.has(key) &&
            retry.attempts === 0 &&
            options.serverIpCurrent() !== undefined &&
            options.serverIpCurrent() !== ""),
      )
      if (dueDeletion === undefined && dueProject === undefined) return
      if (dueDeletion !== undefined && (dueProject === undefined || dueDeletion[1].sequence < dueProject[1].sequence)) {
        await trackedRecordDeletionRun(dueDeletion[0])
        continue
      }
      const retry = dueProject![1]
      // Force wakes each deferred project once, not repeatedly within this
      // drain: missing credentials must still honor their retry deadline.
      forcedProjects.add(dueProject![0])
      const outcome = await projectRun(dueProject![0], retry.sequence)
      if (outcome === "failed" && pendingProjects.get(dueProject![0])?.sequence === retry.sequence)
        retryProject(dueProject![0], retry, false)
      if (outcome === "deferred" && pendingProjects.get(dueProject![0])?.sequence === retry.sequence)
        retryProject(dueProject![0], retry, true)
      // A project with unavailable credentials or an inaccessible zone must not
      // prevent unrelated owners' projects from reconciling.
    }
  }

  function hasDueWork(): boolean {
    if (trackingBlocked) return false
    return (
      (startupRetry !== undefined && pendingDue(startupRetry)) ||
      [...pendingDeletions.values()].some((retry) => pendingDue(retry)) ||
      [...pendingProjects.values()].some((retry) => pendingDue(retry))
    )
  }

  function drainSchedule(force = false): void {
    if (!started || stopped) return
    if (drainPromise !== undefined) {
      forceDrain ||= force
      return
    }
    const requestedForce = forceDrain || force
    forceDrain = false
    const current = Promise.resolve()
      .then(() => drain(requestedForce))
      .catch(() => {
        // Unexpected queue failures must be visible and must not hot-loop.
        trackingBlocked = true
        logEvent("reconciliation", "failure", { operation: "queue", reason: "unexpected-error" })
        statusErrorUpsert({
          operation: "queue",
          errorMessage: "Unexpected DNS queue failure; restart the daemon after investigating its logs",
          attempts: 0,
          occurredAt: clock(),
        })
      })
    drainPromise = current
    void current.then(() => {
      if (drainPromise !== current) return
      drainPromise = undefined
      if (!stopped && hasDueWork()) drainSchedule()
    })
  }

  function projectQueueSet(project: Project): void {
    if (!active || !started || stopped) return
    intervalEnsure()
    const key = projectKeyValue(project)
    const excludedHostnames = new Set([...externalHostnames(project), ...(protectedHostnames.get(key) ?? [])])
    for (const record of state.records) {
      if (excludedHostnames.has(projectDomainNormalize(record.name))) deletionPendingClear(recordKeyValue(record))
    }
    desiredProjects.set(key, project)
    pendingProjects.set(key, {
      attempts: 0,
      nextAt: 0,
      sequence: nextSequence++,
    })
    drainSchedule()
  }

  function projectCreateAfterPersistence(project: Project, createOptions: ProjectCreateOptions): void {
    if (createOptions.noDns) return
    protectedHostnames.delete(projectKeyValue(project))
    projectQueueSet(project)
  }

  function projectEditAfterPersistence(previous: Project, project: Project): void {
    protectedHostnames.set(projectKeyValue(project), new Set(externalHostnames(previous)))
    projectQueueSet(project)
  }

  function projectDeleteAfterPersistence(project: Project): void {
    if (!active || !started || stopped) return
    intervalEnsure()
    const key = projectKeyValue(project)
    protectedHostnames.set(key, new Set(externalHostnames(project)))
    for (const record of state.records) {
      if (protectedHostnames.get(key)?.has(projectDomainNormalize(record.name)))
        deletionPendingClear(recordKeyValue(record))
    }
    desiredProjects.delete(key)
    pendingProjects.set(key, {
      attempts: 0,
      nextAt: 0,
      sequence: nextSequence++,
    })
    drainSchedule()
  }

  function status(): ProjectRegistryDaemonCloudflareDnsStatus {
    const snapshot = {
      enabled: active,
      pendingProjects: pendingProjects.size,
      pendingDeletions: pendingDeletions.size,
      trackingBlocked,
      ...(lastSuccessAt === undefined ? {} : { lastSuccess: lastSuccessAt }),
      errors: [...statusErrors.values()]
        .sort((left, right) => left.occurredAt - right.occurredAt)
        .map((entry) => ({ ...entry })),
    }
    const parsed = a.safeParse(projectRegistryDaemonCloudflareDnsStatusSchema, snapshot)
    if (!parsed.success) {
      return {
        enabled: active,
        pendingProjects: pendingProjects.size,
        pendingDeletions: pendingDeletions.size,
        trackingBlocked: true,
        errors: [{ operation: "status", errorMessage: "DNS status unavailable", attempts: 0, occurredAt: 0 }],
      }
    }
    return parsed.output
  }

  function start(): Result<void> {
    if (started) return createResult(undefined)
    if (stopped) return createResultError(op, "Cloudflare DNS queue has stopped")
    started = true
    intervalEnsure()
    startupPromise = Promise.resolve()
      .then(trackingStateInitialize)
      .then(async () => {
        if (startupRetry !== undefined || trackingBlocked || stopped) return
        await recurringReconcile()
      })
      .catch(() => {
        trackingBlocked = true
        logEvent("tracking", "failure", { operation: "startup", reason: "tracking-startup-failed" })
        statusErrorUpsert({
          operation: "startup",
          errorMessage: "tracking-startup-failed",
          attempts: 0,
          occurredAt: clock(),
        })
      })
    drainSchedule()
    return createResult(undefined)
  }

  function shutdown(): PromiseResult<void> {
    if (shutdownPromise !== undefined) return shutdownPromise
    stopped = true
    controller.abort()
    if (intervalHandle !== undefined) {
      try {
        options.timer.clearInterval(intervalHandle)
      } catch {
        // Queue cancellation continues even when timer cleanup fails.
      }
      intervalHandle = undefined
    }
    pendingProjects.clear()
    pendingDeletions.clear()
    pendingDeletionOwners.clear()
    const current = drainPromise
    const startup = startupPromise
    const wait = Promise.all([current, startup].filter((value): value is Promise<void> => value !== undefined))
    shutdownPromise = wait.then(
      () => createResult(undefined),
      () => createResultError(op, "Cloudflare DNS queue shutdown failed"),
    )
    return shutdownPromise
  }

  return createResult({
    start,
    shutdown,
    status,
    projectCreateAfterPersistence,
    projectEditAfterPersistence,
    projectDeleteAfterPersistence,
  })
}
