import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { CloudflareDnsFetch } from "../cloudflare/CloudflareDnsFetch.js"
import type { CloudflareDnsReconcileResult } from "../cloudflare/CloudflareDnsReconcileResult.js"
import type { CloudflareDnsTrackedRecord } from "../cloudflare/CloudflareDnsTrackedRecord.js"
import { cloudflareDnsDeleteById } from "../cloudflare/cloudflareDnsDeleteById.js"
import { cloudflareDnsReconcile } from "../cloudflare/cloudflareDnsReconcile.js"
import type { Project } from "../project/Project.js"
import { projectCaddyEntries } from "../project/projectCaddyEntries.js"
import { projectDomainIsCloudflarePages } from "../project/projectDomainIsCloudflarePages.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import type { ProjectKey } from "../project/projectKey.js"
import { projectLocalCaddyEntries } from "../project/projectLocalCaddyEntries.js"
import type { ProjectService } from "../project/projectServiceSchema.js"
import type { ProjectRegistryDaemonCloudflareDnsTracking } from "./ProjectRegistryDaemonCloudflareDnsTracking.js"
import type { ProjectRegistryDaemonCloudflareDnsTrackingState } from "./ProjectRegistryDaemonCloudflareDnsTrackingState.js"

const reconcileIntervalMs = 1_000
const retryBaseMs = 1_000
const retryMaximumMs = 60_000

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

function projectKeyValue(project: ProjectKey): string {
  return `${project.owner}\u0000${project.name}`
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

function hostnames(project: Project): string[] {
  const values = new Set<string>()
  for (const entry of projectLocalCaddyEntries(project)) {
    if (entry.caddy.disabled) continue
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
    if (!hostnames(project).includes(hostname)) continue
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
  let state = stateEmpty()
  let trackingBlocked = false
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

  function deletionStateRetry(key: string): RetryState {
    return pendingDeletions.get(key) ?? { attempts: 0, nextAt: 0, sequence: nextSequence++ }
  }

  function retryProject(key: string, retry: RetryState, deferred: boolean): void {
    const attempts = deferred ? retry.attempts : retry.attempts + 1
    pendingProjects.set(key, {
      attempts,
      nextAt: clock() + (deferred ? retryBaseMs : retryDelay(attempts)),
      sequence: retry.sequence,
    })
  }

  function retryDeletion(key: string): void {
    const retry = deletionStateRetry(key)
    const attempts = retry.attempts + 1
    pendingDeletions.set(key, { attempts, nextAt: clock() + retryDelay(attempts), sequence: retry.sequence })
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

  async function tokenForOwner(owner: string): Promise<Result<string | undefined>> {
    if (options.credentialResolve === undefined) return createResult(undefined)
    try {
      const result = await options.credentialResolve(owner)
      if (typeof result !== "object" || result === null || typeof result.success !== "boolean") {
        return createResultError(
          "projectRegistryDaemonCloudflareDnsCredentialResolve",
          "Cloudflare credentials are invalid",
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
      log("cloudflare DNS timer setup failed")
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
        log(`cloudflare DNS repository snapshot outcome=failure reason=${result.errorMessage}`)
        return createResultError("projectRegistryDaemonCloudflareDnsSnapshot", result.errorMessage)
      }
      return createResult(result.data)
    } catch {
      log("cloudflare DNS repository snapshot outcome=failure reason=unexpected-error")
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
      pendingProjects.set(key, { attempts: 0, nextAt: 0, sequence: nextSequence++ })
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
        log(`cloudflare DNS tracking outcome=failure operation=write reason=${result.errorMessage}`)
        return false
      }
      if (stopped) return false
      state = next
      return true
    } catch {
      log("cloudflare DNS tracking outcome=failure operation=write reason=unexpected-error")
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
      log("cloudflare DNS tracking outcome=failure operation=read reason=unexpected-error")
      return
    }
    if (!readR.success) {
      trackingBlocked = true
      log(`cloudflare DNS tracking outcome=failure operation=read reason=${readR.errorMessage}`)
      return
    }
    state = readR.data
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
    for (const record of next.records) {
      const hostname = projectDomainNormalize(record.name)
      const projectKeys = projectKeysForHostname(projects, hostname)
      const externalProjectKeys = projectKeysForExternalHostname(projects, hostname)
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
    startupRetry = undefined
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

  async function deletionRun(record: CloudflareDnsTrackedRecord): Promise<QueueOutcome> {
    if (stopped) return "done"
    if (!active) {
      deletionPendingClear(recordKeyValue(record))
      return "done"
    }
    const deletionOwner = pendingDeletionOwners.get(recordKeyValue(record))
    if (deletionOwner === undefined) {
      log(`cloudflare DNS deletion outcome=deferred recordId=${record.id} reason=owner-credential-unavailable`)
      retryDeletion(recordKeyValue(record))
      return "failed"
    }
    const tokenR = await tokenForOwner(deletionOwner)
    if (!tokenR.success || tokenR.data === undefined) {
      log(`cloudflare DNS deletion outcome=deferred recordId=${record.id} reason=owner-credential-unavailable`)
      retryDeletion(recordKeyValue(record))
      return "failed"
    }
    try {
      const result = await cloudflareDnsDeleteById({
        token: tokenR.data,
        record,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
      if (!result.success) {
        log(`cloudflare DNS deletion outcome=failure recordId=${record.id} reason=${result.errorMessage}`)
        retryDeletion(recordKeyValue(record))
        return "failed"
      }
      if (stopped) return "done"
      const next = stateCopy(state)
      next.records = next.records.filter((entry) => recordKeyValue(entry) !== recordKeyValue(record))
      if (!(await trackingStateWrite(next))) {
        retryDeletion(recordKeyValue(record))
        return "failed"
      }
      deletionPendingClear(recordKeyValue(record))
      return "done"
    } catch {
      log(`cloudflare DNS deletion outcome=failure recordId=${record.id} reason=unexpected-error`)
      retryDeletion(recordKeyValue(record))
      return "failed"
    }
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
    return deletionRun(record)
  }

  async function projectOwnershipReconcile(
    project: Project,
    projects: ProjectSnapshot,
    previousExcludedHostnames: ReadonlySet<string>,
  ): Promise<QueueOutcome> {
    const key = { owner: project.owner, name: project.name }
    const currentDomains = new Set(hostnames(project))
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
      if (
        previousExcludedHostnames.has(hostname) ||
        currentExcludedHostnames.has(hostname) ||
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
        deletionSchedule(recordKeyValue(record), record.projectKeys)
        if (pendingDeletions.has(recordKeyValue(record)) && pendingDue(pendingDeletions.get(recordKeyValue(record))!)) {
          await trackedRecordDeletionRun(recordKeyValue(record))
        }
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

  async function projectRemoteReconcile(project: Project, projects: ProjectSnapshot): Promise<QueueOutcome> {
    const address = options.serverIpCurrent()
    if (address === undefined || address === "") return "deferred"
    const tokenR = await tokenForOwner(project.owner)
    if (!tokenR.success || tokenR.data === undefined) return "deferred"
    for (const hostname of hostnames(project)) {
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
        log(`cloudflare DNS reconciliation outcome=failure hostname=${hostname} reason=unexpected-error`)
        return "failed"
      }
      if (!reconcileR.success) {
        log(`cloudflare DNS reconciliation outcome=failure hostname=${hostname} reason=${reconcileR.errorMessage}`)
        return "failed"
      }
      if (stopped) return "done"
      const existing = state.records.find(
        (record) => record.zoneId === reconcileR.data.zone.id && record.id === reconcileR.data.record.id,
      )
      const projectKey = { owner: project.owner, name: project.name }
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
      if (!(await trackingStateWrite(next))) return "failed"
      deletionPendingClear(recordKeyValue(tracked))
    }
    return "done"
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
    const desired =
      projects === undefined || requested === undefined
        ? requested
        : projects.find((project) => projectKeyValue(project) === keyValue)
    if (desired === undefined) {
      if (projectsR.success && projects === undefined && options.repositoryProjectsCurrent !== undefined)
        return "failed"
      if (options.tracking !== undefined) {
        const projectKey = { owner: keyValue.split("\u0000")[0]!, name: keyValue.split("\u0000")[1]! }
        const records = state.records.filter((record) =>
          record.projectKeys.some((key) => projectKeyEqual(key, projectKey)),
        )
        for (const record of records) {
          const hostname = projectDomainNormalize(record.name)
          const owners = currentOwners(record, projectKey, projects)
          if (protectedHostnames.get(keyValue)?.has(hostname) === true || projectDomainIsCloudflarePages(hostname)) {
            if (owners.length === 0) {
              if (!(await trackingRecordRelease(record))) return "failed"
            } else if (!(await trackingRecordOwnersSet(record, owners))) {
              return "failed"
            }
            continue
          }
          if (owners.length === 0) {
            deletionSchedule(
              recordKeyValue(record),
              record.projectKeys.length === 0 ? [projectKey] : record.projectKeys,
            )
            if (
              pendingDeletions.has(recordKeyValue(record)) &&
              pendingDue(pendingDeletions.get(recordKeyValue(record))!)
            ) {
              await trackedRecordDeletionRun(recordKeyValue(record))
            }
            continue
          }
          if (!(await trackingRecordOwnersSet(record, owners))) return "failed"
        }
      }
      if (pendingProjects.get(keyValue)?.sequence === sequence) pendingProjects.delete(keyValue)
      return "done"
    }

    if (options.tracking !== undefined) {
      const ownershipOutcome = await projectOwnershipReconcile(
        desired,
        projects,
        protectedHostnames.get(keyValue) ?? new Set<string>(),
      )
      if (ownershipOutcome !== "done") return ownershipOutcome
    }
    const remoteOutcome = await projectRemoteReconcile(desired, projects)
    if (remoteOutcome !== "done") return remoteOutcome
    protectedHostnames.delete(keyValue)
    if (pendingProjects.get(keyValue)?.sequence === sequence) pendingProjects.delete(keyValue)
    return "done"
  }

  async function drain(force: boolean): Promise<void> {
    if (!started || stopped || (!active && options.tracking === undefined)) return
    if (startupPromise !== undefined) await startupPromise
    if (stopped || trackingBlocked) return

    while (!stopped) {
      if (startupRetry !== undefined && pendingDue(startupRetry)) {
        startupRetry = undefined
        await trackingStateInitialize()
        if (startupRetry !== undefined || trackingBlocked) return
      }
      const dueDeletion = [...pendingDeletions.entries()].find(([, retry]) => pendingDue(retry))
      const dueProject = [...pendingProjects.entries()].find(
        ([, retry]) =>
          pendingDue(retry) ||
          (force &&
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
      const outcome = await projectRun(dueProject![0], retry.sequence)
      if (outcome === "failed" && pendingProjects.get(dueProject![0])?.sequence === retry.sequence)
        retryProject(dueProject![0], retry, false)
      if (outcome === "deferred" && pendingProjects.get(dueProject![0])?.sequence === retry.sequence)
        retryProject(dueProject![0], retry, true)
      if (outcome !== "done") return
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
      .catch(() => undefined)
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

  function start(): Result<void> {
    if (started) return createResult(undefined)
    if (stopped) return createResultError(op, "Cloudflare DNS queue has stopped")
    started = true
    startupPromise = Promise.resolve()
      .then(trackingStateInitialize)
      .then(async () => {
        if (startupRetry !== undefined || trackingBlocked || stopped) return
        await recurringReconcile()
      })
      .catch(() => {
        trackingBlocked = true
        log("cloudflare DNS tracking outcome=failure operation=startup reason=unexpected-error")
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
    projectCreateAfterPersistence,
    projectEditAfterPersistence,
    projectDeleteAfterPersistence,
  })
}
