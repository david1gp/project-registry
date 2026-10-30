import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { dirname, isAbsolute, join } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectDnsPlanCreate } from "../project/projectDnsPlanCreate.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import type { ProjectKey } from "../project/projectKey.js"
import { projectLocalCaddyEntries } from "../project/projectLocalCaddyEntries.js"
import { projectTailscaleZoneClaimValidate, projectTailscaleZonePolicy } from "../project/projectTailscaleZonePolicy.js"
import type { TailscaleSplitDnsFetch } from "../tailscale/TailscaleSplitDnsFetch.js"
import { tailscaleDnsmasqConfigRender } from "../tailscale/tailscaleDnsmasqConfigRender.js"
import { tailscaleHostnameNormalize } from "../tailscale/tailscaleHostnameNormalize.js"
import { tailscaleSplitDnsApply } from "../tailscale/tailscaleSplitDnsApply.js"
import { tailscaleSplitDnsErrorDetailsRead } from "../tailscale/tailscaleSplitDnsErrorDetailsRead.js"
import { tailscaleSplitDnsRemove } from "../tailscale/tailscaleSplitDnsRemove.js"
import type { ProjectRegistryDaemonPrivateDnsTracking } from "./ProjectRegistryDaemonPrivateDnsTracking.js"
import type { ProjectRegistryDaemonPrivateDnsTrackingFilesystem } from "./ProjectRegistryDaemonPrivateDnsTrackingFilesystem.js"
import type {
  ProjectRegistryDaemonPrivateDnsTrackedHost,
  ProjectRegistryDaemonPrivateDnsTrackingState,
} from "./ProjectRegistryDaemonPrivateDnsTrackingState.js"
import {
  type ProjectRegistryDaemonPrivateDnsStatus,
  projectRegistryDaemonPrivateDnsStatusSchema,
} from "./projectRegistryDaemonPrivateDnsStatusSchema.js"

// Retry wake-up cadence. The queue is event-driven: project commands queue
// work immediately and this timer only exists to retry deferred work. It is
// disarmed whenever the queue is fully idle, so a reconciled daemon performs
// no periodic repository reads at all.
const retryTickMs = 1_000
const retryBaseMs = 1_000
const retryMaximumMs = 60_000
const maxStatusErrors = 20
const resolverDirectoryMode = 0o755
const resolverFileMode = 0o644
const splitDnsStateDirectoryMode = 0o700
const splitDnsStateFileMode = 0o600
const tailscaleApiBaseUrlDefault = "https://api.tailscale.com/api/v2"

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

function projectKeyEqual(left: ProjectKey, right: ProjectKey): boolean {
  return left.owner === right.owner && left.name === right.name
}

function caddyEntryVisibility(caddy: { networkVisibility?: unknown }): "public" | "private" {
  return (caddy as { networkVisibility?: unknown }).networkVisibility === "private" ? "private" : "public"
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

function projectKeysEqual(left: readonly ProjectKey[], right: readonly ProjectKey[]): boolean {
  if (left.length !== right.length) return false
  return left.every((key, index) => projectKeyEqual(key, right[index]!))
}

function retryDelay(attempts: number): number {
  return Math.min(retryMaximumMs, retryBaseMs * 2 ** Math.min(attempts, 6))
}

function stateEmpty(): ProjectRegistryDaemonPrivateDnsTrackingState {
  return { version: 1, hosts: [] }
}

function stateCopy(state: ProjectRegistryDaemonPrivateDnsTrackingState): ProjectRegistryDaemonPrivateDnsTrackingState {
  return {
    version: state.version,
    ...(state.resolver === undefined ? {} : { resolver: { ...state.resolver } }),
    hosts: state.hosts.map((host) => ({
      ...host,
      projectKeys: host.projectKeys.map((project) => ({ ...project })),
    })),
  }
}

function fieldEscape(value: string): string {
  return value.replace(/[\s=]+/g, "_")
}

function ownerFileName(owner: string): string | undefined {
  if (
    owner.length === 0 ||
    owner === "." ||
    owner === ".." ||
    owner.includes("/") ||
    owner.includes("\\") ||
    owner.includes("\0")
  ) {
    return undefined
  }
  return `${owner}.split-dns.json`
}

function contentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function tailscaleZoneSuffixes(): string[] {
  const zones = new Set<string>()
  for (const owned of Object.values(projectTailscaleZonePolicy)) {
    for (const zone of owned) zones.add(`.${zone}`)
  }
  return [...zones]
}

export function projectRegistryDaemonPrivateDnsCreate(options: {
  enabled: boolean
  grandfatheredHostnames?: readonly string[]
  tailnet: string
  nodeAddress: string
  apiBaseUrl?: string
  upstreamResolvers: readonly string[]
  dnsmasqConfigPath: string
  splitDnsStateDirectory: string
  credentialResolve?: () => PromiseResult<string | undefined>
  fetch?: TailscaleSplitDnsFetch
  filesystem: ProjectRegistryDaemonPrivateDnsTrackingFilesystem
  resolverReload?: () => PromiseResult<void>
  logger?: (message: string) => void
  tracking?: ProjectRegistryDaemonPrivateDnsTracking
  repositoryProjectsCurrent?: () => PromiseResult<readonly Project[]>
  clock?: () => number
  timer: {
    setInterval(callback: () => void, delayMs: number): unknown
    clearInterval(handle: unknown): void
  }
}): Result<{
  start(): Result<void>
  shutdown(): PromiseResult<void>
  status(): ProjectRegistryDaemonPrivateDnsStatus
  projectCreateAfterPersistence(project: Project, options: ProjectCreateOptions): void
  projectEditAfterPersistence(previous: Project, project: Project): void
  projectDeleteAfterPersistence(project: Project): void
}> {
  const op = "projectRegistryDaemonPrivateDnsCreate"
  if (typeof options !== "object" || options === null) return createResultError(op, "Private DNS options are required")
  if (typeof options.enabled !== "boolean") return createResultError(op, "Private DNS enabled flag is invalid")
  // Tailnet and node address are required only when enabled: a disabled queue
  // stays idle and never touches split-DNS or the resolver.
  if (options.enabled) {
    if (typeof options.tailnet !== "string" || options.tailnet.trim() === "")
      return createResultError(op, "Private DNS tailnet is invalid")
    if (typeof options.nodeAddress !== "string" || isIP(options.nodeAddress) !== 4)
      return createResultError(op, "Private DNS node address must be an IPv4 address")
  }
  if (options.apiBaseUrl !== undefined) {
    try {
      const apiBase = new URL(options.apiBaseUrl)
      if (
        apiBase.protocol !== "https:" ||
        apiBase.username !== "" ||
        apiBase.password !== "" ||
        apiBase.search !== "" ||
        apiBase.hash !== ""
      ) {
        return createResultError(op, "Private DNS API URL is invalid")
      }
    } catch {
      return createResultError(op, "Private DNS API URL is invalid")
    }
  }
  if (
    !Array.isArray(options.upstreamResolvers) ||
    options.upstreamResolvers.length === 0 ||
    options.upstreamResolvers.some((resolver) => typeof resolver !== "string" || isIP(resolver) !== 4)
  ) {
    return createResultError(op, "Private DNS upstream resolvers are invalid")
  }
  if (
    typeof options.dnsmasqConfigPath !== "string" ||
    options.dnsmasqConfigPath.length === 0 ||
    !isAbsolute(options.dnsmasqConfigPath) ||
    options.dnsmasqConfigPath.includes("\0")
  ) {
    return createResultError(op, "Private DNS dnsmasq config path is invalid")
  }
  if (
    typeof options.splitDnsStateDirectory !== "string" ||
    options.splitDnsStateDirectory.length === 0 ||
    !isAbsolute(options.splitDnsStateDirectory) ||
    options.splitDnsStateDirectory.includes("\0")
  ) {
    return createResultError(op, "Private DNS split-DNS state directory is invalid")
  }
  if (typeof options.filesystem !== "object" || options.filesystem === null) {
    return createResultError(op, "Private DNS filesystem is required")
  }
  const filesystemMethods = ["readFile", "mkdir", "writeFile", "rename", "unlink"] as const
  if (filesystemMethods.some((method) => typeof options.filesystem[method] !== "function")) {
    return createResultError(op, "Private DNS filesystem is invalid")
  }
  if (options.resolverReload !== undefined && typeof options.resolverReload !== "function") {
    return createResultError(op, "Private DNS resolver reload is invalid")
  }
  if (
    options.grandfatheredHostnames !== undefined &&
    (!Array.isArray(options.grandfatheredHostnames) ||
      options.grandfatheredHostnames.some((hostname) => tailscaleHostnameNormalize(hostname) === undefined))
  ) {
    return createResultError(op, "Private DNS grandfathered hostnames must be exact private FQDNs")
  }
  if (options.logger !== undefined && typeof options.logger !== "function") {
    return createResultError(op, "Private DNS logger is invalid")
  }
  if (options.tracking !== undefined && typeof options.tracking !== "object") {
    return createResultError(op, "Private DNS tracking is invalid")
  }
  if (options.repositoryProjectsCurrent !== undefined && typeof options.repositoryProjectsCurrent !== "function") {
    return createResultError(op, "Private DNS project snapshot accessor is invalid")
  }
  if (typeof options.timer !== "object" || options.timer === null) {
    return createResultError(op, "Private DNS timer is required")
  }

  const active = options.enabled
  const tailnet = options.tailnet.trim()
  const nodeAddress = options.nodeAddress
  const apiBaseUrl = options.apiBaseUrl ?? tailscaleApiBaseUrlDefault
  const upstreamResolvers = [...options.upstreamResolvers]
  const grandfatheredHostnames = new Set<string>()
  for (const hostname of options.grandfatheredHostnames ?? []) {
    const normalized = tailscaleHostnameNormalize(hostname)
    if (normalized !== undefined) grandfatheredHostnames.add(normalized)
  }
  const dnsmasqConfigPath = options.dnsmasqConfigPath
  const splitDnsStateDirectory = options.splitDnsStateDirectory
  const filesystem = options.filesystem
  const pendingProjects = new Map<string, RetryState>()
  const desiredProjects = new Map<string, Project>()
  const pendingDeletions = new Map<string, RetryState>()
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
    event: "reconciliation" | "deletion" | "tracking" | "snapshot" | "credential" | "recovery" | "resolver",
    outcome: "success" | "failure" | "deferred",
    fields: {
      owner?: string
      project?: string
      hostname?: string
      zone?: string
      operation?: string
      action?: string
      attempt?: number
      nextRetryMs?: number
      statusCode?: number
      reason?: string
      detail?: string
    },
  ): void {
    const parts = [`private DNS ${event} outcome=${outcome}`]
    if (fields.owner !== undefined) parts.push(`owner=${fieldEscape(fields.owner)}`)
    if (fields.project !== undefined) parts.push(`project=${fieldEscape(fields.project)}`)
    if (fields.hostname !== undefined) parts.push(`hostname=${fieldEscape(fields.hostname)}`)
    if (fields.zone !== undefined) parts.push(`zone=${fieldEscape(fields.zone)}`)
    if (fields.operation !== undefined) parts.push(`operation=${fieldEscape(fields.operation)}`)
    if (fields.action !== undefined) parts.push(`action=${fieldEscape(fields.action)}`)
    if (fields.attempt !== undefined) parts.push(`attempt=${fields.attempt}`)
    if (fields.nextRetryMs !== undefined) parts.push(`nextRetryMs=${fields.nextRetryMs}`)
    if (fields.statusCode !== undefined) parts.push(`status=${fields.statusCode}`)
    if (fields.reason !== undefined) parts.push(`reason=${fieldEscape(fields.reason)}`)
    if (fields.detail !== undefined) parts.push(`detail=${fieldEscape(fields.detail)}`)
    const message = parts.join(" ")
    const key = [event, fields.owner, fields.project, fields.hostname].join("\u0000")
    const alreadyReported = [...statusErrors.values()].some(
      (entry) => entry.owner === fields.owner && entry.project === fields.project && entry.hostname === fields.hostname,
    )
    if (lastLogEvents.get(key) === message && (outcome === "success" || alreadyReported)) return
    lastLogEvents.delete(key)
    lastLogEvents.set(key, message)
    if (lastLogEvents.size > 1000) lastLogEvents.delete(lastLogEvents.keys().next().value!)
    log(message)
  }

  function statusErrorKey(entry: Pick<StatusErrorEntry, "operation" | "owner" | "project" | "hostname">): string {
    return [entry.operation, entry.owner ?? "", entry.project ?? "", entry.hostname ?? ""].join("\u0000")
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

  function successClearOperation(operation: string): void {
    statusErrorsClear((entry) => entry.operation === operation)
  }

  function successClearProject(owner: string, project: string): void {
    statusErrorsClear((entry) => entry.owner === owner && entry.project === project && entry.hostname === undefined)
  }

  function claimErrorRecord(owner: string, project: string, hostname: string, message: string): void {
    const exists = [...statusErrors.values()].some(
      (entry) =>
        entry.operation === "claim" &&
        entry.owner === owner &&
        entry.project === project &&
        entry.hostname === hostname &&
        entry.errorMessage === message,
    )
    if (!exists) {
      statusErrorUpsert({
        owner,
        project,
        hostname,
        operation: "claim",
        errorMessage: message,
        attempts: 0,
        occurredAt: clock(),
      })
    }
    logEvent("reconciliation", "failure", { owner, project, hostname, operation: "claim", reason: message })
  }

  function deletionStateRetry(key: string): RetryState {
    return pendingDeletions.get(key) ?? { attempts: 0, nextAt: 0, sequence: nextSequence++ }
  }

  function retryProject(key: string, retry: RetryState): void {
    // Deferred work (missing server IP or credentials) backs off exactly
    // like failed work: a fixed one-second retry would re-read the repository
    // and re-resolve credentials every second for as long as the environment
    // stays unavailable. An appearing server IP wakes deferred work early
    // through the tick's address-change check.
    const attempts = retry.attempts + 1
    pendingProjects.delete(key)
    pendingProjects.set(key, {
      attempts,
      nextAt: clock() + retryDelay(attempts),
      sequence: retry.sequence,
    })
    intervalEnsure()
  }

  function retryDeletion(key: string): { attempts: number; nextRetryMs: number } {
    const retry = deletionStateRetry(key)
    const attempts = retry.attempts + 1
    const nextRetryMs = retryDelay(attempts)
    pendingDeletions.set(key, { attempts, nextAt: clock() + nextRetryMs, sequence: retry.sequence })
    intervalEnsure()
    return { attempts, nextRetryMs }
  }

  function deletionSchedule(key: string): void {
    pendingDeletions.set(key, deletionStateRetry(key))
  }

  function deletionPendingClear(key: string): void {
    pendingDeletions.delete(key)
  }

  function runIsCurrent(keyValue: string, sequence: number): boolean {
    return pendingProjects.get(keyValue)?.sequence === sequence
  }

  async function tokenResolve(): Promise<Result<string | undefined>> {
    if (options.credentialResolve === undefined) return createResult(undefined)
    try {
      const result = await options.credentialResolve()
      if (typeof result !== "object" || result === null || typeof result.success !== "boolean") {
        return createResultError(
          "projectRegistryDaemonPrivateDnsCredentialResolve",
          "Private DNS credentials could not be loaded",
        )
      }
      if (!result.success)
        return createResultError(
          "projectRegistryDaemonPrivateDnsCredentialResolve",
          "Private DNS credentials could not be loaded",
        )
      if (
        result.data !== undefined &&
        (typeof result.data !== "string" || result.data.length === 0 || result.data.trim() !== result.data)
      ) {
        return createResultError(
          "projectRegistryDaemonPrivateDnsCredentialResolve",
          "Private DNS credentials are invalid",
        )
      }
      return createResult(result.data)
    } catch {
      return createResultError(
        "projectRegistryDaemonPrivateDnsCredentialResolve",
        "Private DNS credentials could not be loaded",
      )
    }
  }

  function pendingDue(retry: RetryState): boolean {
    return retry.nextAt <= clock()
  }

  function queueIdle(): boolean {
    return pendingProjects.size === 0 && pendingDeletions.size === 0 && startupRetry === undefined
  }

  function intervalClear(): void {
    if (intervalHandle === undefined) return
    try {
      options.timer.clearInterval(intervalHandle)
    } catch {
      // Queue cancellation continues even when timer cleanup fails.
    }
    intervalHandle = undefined
  }

  function intervalRelease(): void {
    if (intervalHandle === undefined) return
    intervalClear()
  }

  function intervalTick(): void {
    if (!active || !started || stopped) return
    if (trackingBlocked) {
      // A blocked queue never proceeds again until restart: stop ticking.
      intervalClear()
      return
    }
    if (queueIdle()) {
      // No deferred work is waiting for a retry: stop ticking until new
      // work is queued by a project command.
      intervalRelease()
      return
    }
    if (!hasDueWork()) {
      // Nothing is due: stay armed but perform no repository read until a
      // retry comes due.
      return
    }
    if (options.repositoryProjectsCurrent === undefined) {
      drainSchedule(true)
      return
    }
    void recurringReconcile()
  }

  function intervalEnsure(): void {
    if (!active || stopped || intervalHandle !== undefined) return
    try {
      intervalHandle = options.timer.setInterval(intervalTick, retryTickMs)
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
    intervalEnsure()
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
        return createResultError("projectRegistryDaemonPrivateDnsSnapshot", result.errorMessage)
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
      return createResultError("projectRegistryDaemonPrivateDnsSnapshot", "repository snapshot failed")
    }
  }

  function projectSnapshotKey(project: Project): string {
    return JSON.stringify(project)
  }

  async function recurringReconcile(): Promise<void> {
    if (!active || !started || stopped) return
    const projectsR = await currentProjects()
    if (!projectsR.success || projectsR.data === undefined) {
      drainSchedule(true)
      return
    }

    // The scan only feeds genuinely new or changed projects into the queue.
    // Already-reconciled projects stay out: reprocessing them every second
    // re-read the repository and re-applied split-DNS for zero effect.
    for (const project of projectsR.data) {
      const key = projectKeyValue(project)
      const previous = desiredProjects.get(key)
      if (previous !== undefined && projectSnapshotKey(previous) === projectSnapshotKey(project)) continue
      desiredProjects.set(key, project)
      if (!pendingProjects.has(key)) pendingProjects.set(key, { attempts: 0, nextAt: 0, sequence: nextSequence++ })
    }
    drainSchedule(true)
  }

  async function trackingStateWrite(next: ProjectRegistryDaemonPrivateDnsTrackingState): Promise<boolean> {
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

  type DesiredHost = { hostname: string; zone: string }

  function desiredHostsForProject(project: Project): DesiredHost[] {
    const desired: DesiredHost[] = []
    for (const hostname of privateHostnames(project)) {
      const claimR = projectTailscaleZoneClaimValidate(project.owner, hostname, op)
      if (!claimR.success) {
        // Grandfathered pre-migration names keep converging until an edit
        // removes them; every other legacy or conflicting claim stays out
        // and stays visible as a claim error.
        if (grandfatheredHostnames.has(hostname)) {
          successClearHostname(hostname, project.owner, project.name)
          desired.push({ hostname, zone: hostname })
          continue
        }
        claimErrorRecord(project.owner, project.name, hostname, claimR.errorMessage)
        continue
      }
      successClearHostname(hostname, project.owner, project.name)
      desired.push({ hostname, zone: claimR.data })
    }
    return desired.sort((left, right) => (left.hostname < right.hostname ? -1 : 1))
  }

  function publicPassthroughsForSnapshot(projects: ProjectSnapshot): string[] {
    if (projects === undefined) return []
    const suffixes = tailscaleZoneSuffixes()
    const passthroughs = new Set<string>()
    for (const project of projects) {
      for (const hostname of publicHostnames(project)) {
        if (suffixes.some((suffix) => hostname.endsWith(suffix))) passthroughs.add(hostname)
      }
    }
    return [...passthroughs].sort()
  }

  async function fileWriteAtomic(
    path: string,
    content: string,
    directoryMode: number,
    fileMode: number,
  ): Promise<boolean> {
    const temporaryPath = `${path}.tmp-${process.pid}`
    try {
      await filesystem.mkdir(dirname(path), directoryMode)
      await filesystem.writeFile(temporaryPath, content, fileMode)
      await filesystem.rename(temporaryPath, path)
      return true
    } catch {
      try {
        await filesystem.unlink(temporaryPath)
      } catch {
        // Preserve the atomic write failure.
      }
      return false
    }
  }

  function splitDnsStatePathForOwner(owner: string): string | undefined {
    const filename = ownerFileName(owner)
    if (filename === undefined) return undefined
    return join(splitDnsStateDirectory, filename)
  }

  async function splitDnsStateWrite(path: string, content: string): Promise<void> {
    const written = await fileWriteAtomic(path, content, splitDnsStateDirectoryMode, splitDnsStateFileMode)
    if (!written) throw new Error("split-DNS rollback state could not be written")
  }

  async function resolverConverge(projects: ProjectSnapshot): Promise<QueueOutcome> {
    const hostnames = state.hosts.map((host) => host.hostname).sort()
    const renderedR = tailscaleDnsmasqConfigRender({
      nodeAddress,
      hostnames,
      upstreamResolvers,
      publicPassthroughs: publicPassthroughsForSnapshot(projects),
    })
    if (!renderedR.success) {
      logEvent("resolver", "failure", { operation: "resolver-render", reason: renderedR.errorMessage })
      statusErrorUpsert({
        operation: "resolver-render",
        errorMessage: renderedR.errorMessage,
        attempts: 0,
        occurredAt: clock(),
      })
      return "failed"
    }
    const hash = contentHash(renderedR.data)
    if (state.resolver?.contentHash === hash) {
      successClearOperation("resolver-write")
      successClearOperation("resolver-reload")
      return "done"
    }
    if (!(await fileWriteAtomic(dnsmasqConfigPath, renderedR.data, resolverDirectoryMode, resolverFileMode))) {
      logEvent("resolver", "failure", { operation: "resolver-write", reason: "resolver-config-write-failed" })
      statusErrorUpsert({
        operation: "resolver-write",
        errorMessage: "resolver-config-write-failed",
        attempts: 0,
        occurredAt: clock(),
      })
      return "failed"
    }
    successClearOperation("resolver-write")
    if (options.resolverReload === undefined) {
      logEvent("resolver", "deferred", { operation: "resolver-reload", reason: "resolver-reload-unavailable" })
      statusErrorUpsert({
        operation: "resolver-reload",
        errorMessage: "resolver-reload-unavailable",
        attempts: 0,
        occurredAt: clock(),
      })
      return "failed"
    }
    let reloadR: Awaited<ReturnType<NonNullable<typeof options.resolverReload>>>
    try {
      reloadR = await options.resolverReload()
    } catch {
      reloadR = createResultError("projectRegistryDaemonPrivateDnsResolverReload", "resolver reload failed")
    }
    if (!reloadR.success) {
      logEvent("resolver", "failure", {
        operation: "resolver-reload",
        reason: reloadR.errorMessage,
      })
      statusErrorUpsert({
        operation: "resolver-reload",
        errorMessage: reloadR.errorMessage,
        attempts: 0,
        occurredAt: clock(),
      })
      return "failed"
    }
    const next = stateCopy(state)
    next.resolver = { contentHash: hash }
    if (!(await trackingStateWrite(next))) return "failed"
    successClearOperation("resolver-reload")
    successRecord()
    logEvent("resolver", "success", { operation: "resolver-reload", detail: `${hostnames.length}-hosts` })
    return "done"
  }

  async function trackingStateInitialize(): Promise<void> {
    if (options.tracking === undefined) return
    let readR: Awaited<ReturnType<ProjectRegistryDaemonPrivateDnsTracking["read"]>>
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
    for (const host of next.hosts) {
      const claimants = projectKeysForPrivateHostname(projects, host.hostname)
      if (claimants.length > 0) {
        if (projectKeysEqual(host.projectKeys, claimants)) continue
        host.projectKeys = claimants
        changed = true
        continue
      }
      // Orphan deletions stay scheduled until their owning projects finish
      // reconciling replacements; the deletion path defers while an owner has
      // pending project work so a restart during a failed rename cannot remove
      // the old entry before the replacement exists.
      deletionSchedule(host.hostname)
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
    if (pendingDeletions.size > 0) intervalEnsure()
  }

  function trackingHostFind(hostname: string): ProjectRegistryDaemonPrivateDnsTrackedHost | undefined {
    return state.hosts.find((host) => host.hostname === hostname)
  }

  async function trackingHostOwnersSet(
    host: ProjectRegistryDaemonPrivateDnsTrackedHost,
    projectKeys: readonly ProjectKey[],
  ): Promise<boolean> {
    if (projectKeysEqual(host.projectKeys, projectKeys)) return true
    const next = stateCopy(state)
    const current = next.hosts.find((entry) => entry.hostname === host.hostname)
    if (current === undefined) return true
    current.projectKeys = projectKeys.map((project) => ({ ...project }))
    return trackingStateWrite(next)
  }

  async function trackingHostRelease(host: ProjectRegistryDaemonPrivateDnsTrackedHost): Promise<boolean> {
    const next = stateCopy(state)
    next.hosts = next.hosts.filter((entry) => entry.hostname !== host.hostname)
    const written = await trackingStateWrite(next)
    if (written) deletionPendingClear(host.hostname)
    return written
  }

  function currentOwners(
    host: ProjectRegistryDaemonPrivateDnsTrackedHost,
    project: ProjectKey,
    projects: ProjectSnapshot,
  ): ProjectKey[] {
    if (projects !== undefined) {
      return projectKeysForPrivateHostname(projects, host.hostname).filter((key) => !projectKeyEqual(key, project))
    }
    return host.projectKeys.filter((key) => !projectKeyEqual(key, project))
  }

  type DeletionExpectation = { keyValue: string; sequence: number; project?: Project }

  function projectDnsSignature(project: Project | undefined): string {
    if (project === undefined) return "deleted"
    return JSON.stringify([privateHostnames(project).sort()])
  }

  function credentialDeferred(
    fields: { owner?: string; project?: string; hostname?: string },
    attempts: number,
    reason: "owner-credential-missing" | "owner-credential-unavailable" | "owner-credential-invalid",
    operation: string,
  ): void {
    const deferredRetryMs = retryDelay(attempts + 1)
    logEvent("credential", "deferred", { ...fields, attempt: attempts, nextRetryMs: deferredRetryMs, reason })
    statusErrorUpsert({
      ...fields,
      operation,
      errorMessage: reason,
      attempts,
      occurredAt: clock(),
      nextRetryAt: clock() + deferredRetryMs,
    })
  }

  async function deletionAttempt(hostname: string, expected?: DeletionExpectation): Promise<QueueOutcome> {
    const host = trackingHostFind(hostname)
    if (host === undefined) {
      deletionPendingClear(hostname)
      return "done"
    }
    // Revalidate against the latest snapshot before touching DNS: a concurrent
    // edit may have reclaimed this hostname for the same or another project.
    const projectsR = await currentProjects()
    if (!projectsR.success && options.repositoryProjectsCurrent !== undefined) return "failed"
    const projects = projectsR.success ? projectsR.data : undefined
    const claimants = projectKeysForPrivateHostname(projects, hostname)
    if (claimants.length > 0) {
      if (!(await trackingHostOwnersSet(host, claimants))) return "failed"
      deletionPendingClear(hostname)
      successRecord()
      logEvent("recovery", "success", {
        hostname,
        operation: "split-dns-remove",
        detail: "hostname-reclaimed",
      })
      return "done"
    }
    if (expected !== undefined) {
      if (!runIsCurrent(expected.keyValue, expected.sequence)) return "done"
      const latest =
        projects === undefined ? undefined : projects.find((project) => projectKeyValue(project) === expected.keyValue)
      if (projectDnsSignature(latest) !== projectDnsSignature(expected.project)) {
        if (latest !== undefined) projectQueueSet(latest)
        return "done"
      }
    }
    const tokenR = await tokenResolve()
    if (!tokenR.success) {
      const { attempts, nextRetryMs } = retryDeletion(hostname)
      const reason =
        tokenR.errorMessage === "Private DNS credentials are invalid"
          ? "owner-credential-invalid"
          : "owner-credential-unavailable"
      logEvent("credential", "deferred", {
        owner: host.owner,
        hostname,
        attempt: attempts,
        nextRetryMs,
        reason,
      })
      statusErrorUpsert({
        owner: host.owner,
        hostname,
        operation: "delete",
        errorMessage: reason,
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
      })
      return "failed"
    }
    if (tokenR.data === undefined) {
      const { attempts, nextRetryMs } = retryDeletion(hostname)
      logEvent("credential", "deferred", {
        owner: host.owner,
        hostname,
        attempt: attempts,
        nextRetryMs,
        reason: "owner-credential-missing",
      })
      statusErrorUpsert({
        owner: host.owner,
        hostname,
        operation: "delete",
        errorMessage: "owner-credential-missing",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
      })
      return "failed"
    }
    const statePath = splitDnsStatePathForOwner(host.owner)
    if (statePath === undefined) {
      const { attempts, nextRetryMs } = retryDeletion(hostname)
      logEvent("deletion", "failure", {
        owner: host.owner,
        hostname,
        operation: "state-write",
        attempt: attempts,
        nextRetryMs,
        reason: "owner-state-path-invalid",
      })
      statusErrorUpsert({
        owner: host.owner,
        hostname,
        operation: "state-write",
        errorMessage: "owner-state-path-invalid",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
      })
      return "failed"
    }
    let removeR: Awaited<ReturnType<typeof tailscaleSplitDnsRemove>>
    try {
      removeR = await tailscaleSplitDnsRemove({
        auth: { tailnet, apiKey: tokenR.data, baseUrl: apiBaseUrl },
        hostnames: [hostname],
        nodeAddress,
        stateFile: statePath,
        stateWrite: splitDnsStateWrite,
        signal: controller.signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    } catch {
      const { attempts, nextRetryMs } = retryDeletion(hostname)
      logEvent("deletion", "failure", {
        owner: host.owner,
        hostname,
        operation: "request",
        attempt: attempts,
        nextRetryMs,
        reason: "split-dns-request-failed",
      })
      statusErrorUpsert({
        owner: host.owner,
        hostname,
        operation: "request",
        errorMessage: "split-dns-request-failed",
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
      })
      return "failed"
    }
    if (!removeR.success) {
      const details = tailscaleSplitDnsErrorDetailsRead(removeR)
      const { attempts, nextRetryMs } = retryDeletion(hostname)
      logEvent("deletion", "failure", {
        owner: host.owner,
        hostname,
        operation: details.operation ?? "split-dns-remove",
        attempt: attempts,
        nextRetryMs,
        ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
        reason: removeR.errorMessage,
      })
      statusErrorUpsert({
        owner: host.owner,
        hostname,
        operation: details.operation ?? "split-dns-remove",
        errorMessage: removeR.errorMessage,
        attempts,
        occurredAt: clock(),
        nextRetryAt: clock() + nextRetryMs,
        ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
      })
      return "failed"
    }
    if (stopped) return "done"
    if (!(await trackingHostRelease(host))) {
      retryDeletion(hostname)
      return "failed"
    }
    // The resolver serves only tracked hosts; rewrite it now that the
    // split-DNS entry is gone (create-before-delete already held the entry
    // until every replacement converged).
    const resolverOutcome = await resolverConverge(projects)
    if (resolverOutcome !== "done") {
      retryDeletion(hostname)
      return "failed"
    }
    deletionPendingClear(hostname)
    successRecord()
    successClearHostname(hostname)
    logEvent("deletion", "success", {
      owner: host.owner,
      hostname,
      zone: host.zone,
      operation: "split-dns-remove",
      action: removeR.data.removed.length > 0 ? "removed" : "already-absent",
    })
    return "done"
  }

  async function trackedHostDeletionRun(hostname: string): Promise<QueueOutcome> {
    const host = trackingHostFind(hostname)
    if (host === undefined) {
      deletionPendingClear(hostname)
      return "done"
    }
    // An owner with pending project work may still reconcile a replacement
    // hostname; wait for that run instead of deleting based on stale state.
    // The wait backs off: a fixed one-second retry would re-read the
    // repository every second while the sibling run stays deferred.
    if (host.projectKeys.some((key) => pendingProjects.has(projectKeyValue(key)))) {
      const retry = deletionStateRetry(hostname)
      const attempts = retry.attempts + 1
      pendingDeletions.set(hostname, {
        attempts,
        nextAt: clock() + retryDelay(attempts),
        sequence: retry.sequence,
      })
      return "failed"
    }
    const outcome = await deletionAttempt(hostname)
    if (outcome === "failed" && pendingDeletions.has(hostname) && pendingDue(pendingDeletions.get(hostname)!))
      retryDeletion(hostname)
    return outcome
  }

  async function projectOwnershipReconcile(
    project: Project,
    projects: ProjectSnapshot,
    orphans: string[],
  ): Promise<QueueOutcome> {
    const key = { owner: project.owner, name: project.name }
    const currentDomains = new Set(privateHostnames(project))
    const hostsToRemove = state.hosts.filter(
      (host) =>
        host.projectKeys.some((projectKey) => projectKeyEqual(projectKey, key)) && !currentDomains.has(host.hostname),
    )
    for (const host of hostsToRemove) {
      if (stopped) return "done"
      const owners = currentOwners(host, key, projects)
      if (owners.length === 0) {
        // Create-before-delete: keep the old entry until every replacement
        // for this project reconciles and persists.
        deletionSchedule(host.hostname)
        orphans.push(host.hostname)
        continue
      }
      if (!(await trackingHostOwnersSet(host, owners))) return "failed"
    }

    for (const hostname of currentDomains) {
      const host = trackingHostFind(hostname)
      if (host === undefined) continue
      const snapshotOwners = projects === undefined ? [] : projectKeysForPrivateHostname(projects, hostname)
      const owners =
        projects === undefined
          ? [...host.projectKeys, ...(host.projectKeys.some((entry) => projectKeyEqual(entry, key)) ? [] : [key])]
          : [...snapshotOwners, ...(snapshotOwners.some((entry) => projectKeyEqual(entry, key)) ? [] : [key])]
      const uniqueOwners = owners.filter(
        (entry, index) => owners.findIndex((candidate) => projectKeyEqual(candidate, entry)) === index,
      )
      if (!(await trackingHostOwnersSet(host, uniqueOwners))) return "failed"
      deletionPendingClear(host.hostname)
    }
    return "done"
  }

  async function projectRemoteReconcile(
    project: Project,
    projects: ProjectSnapshot,
    attempts: number,
  ): Promise<QueueOutcome> {
    const projectKey = { owner: project.owner, name: project.name }
    const desired = desiredHostsForProject(project)
    if (desired.length === 0) return "done"
    const tokenR = await tokenResolve()
    if (!tokenR.success) {
      credentialDeferred(
        { owner: project.owner, project: project.name },
        attempts,
        tokenR.errorMessage === "Private DNS credentials are invalid"
          ? "owner-credential-invalid"
          : "owner-credential-unavailable",
        "reconcile",
      )
      return "deferred"
    }
    if (tokenR.data === undefined) {
      credentialDeferred(
        { owner: project.owner, project: project.name },
        attempts,
        "owner-credential-missing",
        "reconcile",
      )
      return "deferred"
    }
    const statePath = splitDnsStatePathForOwner(project.owner)
    if (statePath === undefined) {
      logEvent("reconciliation", "failure", {
        owner: project.owner,
        project: project.name,
        operation: "state-write",
        attempt: attempts + 1,
        nextRetryMs: retryDelay(attempts + 1),
        reason: "owner-state-path-invalid",
      })
      statusErrorUpsert({
        owner: project.owner,
        project: project.name,
        operation: "state-write",
        errorMessage: "owner-state-path-invalid",
        attempts: attempts + 1,
        occurredAt: clock(),
        nextRetryAt: clock() + retryDelay(attempts + 1),
      })
      return "failed"
    }
    let applyR: Awaited<ReturnType<typeof tailscaleSplitDnsApply>>
    try {
      applyR = await tailscaleSplitDnsApply({
        auth: { tailnet, apiKey: tokenR.data, baseUrl: apiBaseUrl },
        hostnames: desired.map((host) => host.hostname),
        nodeAddress,
        stateFile: statePath,
        stateWrite: splitDnsStateWrite,
        signal: controller.signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    } catch {
      logEvent("reconciliation", "failure", {
        owner: project.owner,
        project: project.name,
        operation: "request",
        attempt: attempts + 1,
        nextRetryMs: retryDelay(attempts + 1),
        reason: "split-dns-request-failed",
      })
      statusErrorUpsert({
        owner: project.owner,
        project: project.name,
        operation: "request",
        errorMessage: "split-dns-request-failed",
        attempts: attempts + 1,
        occurredAt: clock(),
        nextRetryAt: clock() + retryDelay(attempts + 1),
      })
      return "failed"
    }
    if (!applyR.success) {
      const details = tailscaleSplitDnsErrorDetailsRead(applyR)
      logEvent("reconciliation", "failure", {
        owner: project.owner,
        project: project.name,
        operation: details.operation ?? "request",
        attempt: attempts + 1,
        nextRetryMs: retryDelay(attempts + 1),
        ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
        reason: applyR.errorMessage,
      })
      statusErrorUpsert({
        owner: project.owner,
        project: project.name,
        operation: details.operation ?? "request",
        errorMessage: applyR.errorMessage,
        attempts: attempts + 1,
        occurredAt: clock(),
        nextRetryAt: clock() + retryDelay(attempts + 1),
        ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
      })
      return "failed"
    }
    if (stopped) return "done"
    // Split-DNS converged; persist every desired host before the resolver
    // starts serving it, so restarts never lose the converged mapping.
    const next = stateCopy(state)
    for (const host of desired) {
      const snapshotOwners = projects === undefined ? [] : projectKeysForPrivateHostname(projects, host.hostname)
      const owners =
        projects === undefined
          ? [...(trackingHostFind(host.hostname)?.projectKeys ?? []), projectKey]
          : [
              ...snapshotOwners,
              ...(snapshotOwners.some((entry) => projectKeyEqual(entry, projectKey)) ? [] : [projectKey]),
            ]
      const uniqueOwners = owners.filter(
        (entry, index) => owners.findIndex((candidate) => projectKeyEqual(candidate, entry)) === index,
      )
      const tracked: ProjectRegistryDaemonPrivateDnsTrackedHost = {
        hostname: host.hostname,
        owner: project.owner,
        zone: host.zone,
        nodeAddress,
        projectKeys: uniqueOwners,
      }
      const index = next.hosts.findIndex((entry) => entry.hostname === host.hostname)
      if (index < 0) next.hosts.push(tracked)
      else next.hosts[index] = tracked
      deletionPendingClear(host.hostname)
    }
    if (!(await trackingStateWrite(next))) return "failed"
    const appliedCount = Object.keys(applyR.data.applied).length
    const recovered = [...statusErrors.values()].some(
      (entry) => entry.owner === project.owner && entry.project === project.name && entry.hostname === undefined,
    )
    for (const host of desired) successClearHostname(host.hostname, project.owner, project.name)
    successClearProject(project.owner, project.name)
    successRecord()
    if (appliedCount > 0 || recovered) {
      logEvent("reconciliation", "success", {
        owner: project.owner,
        project: project.name,
        zone: desired[0]!.zone,
        operation: "split-dns-apply",
        action: appliedCount > 0 ? "applied" : "already-current",
      })
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
      const projectKey = projectKeyParse(keyValue)
      const outcome = await projectOrphansCleanup(projectKey, keyValue, sequence, projects)
      if (outcome !== "done") return outcome
      const deletedKey = projectKeyParse(keyValue)
      statusErrorsClear((entry) => entry.owner === deletedKey.owner && entry.project === deletedKey.name)
      if (pendingProjects.get(keyValue)?.sequence === sequence) pendingProjects.delete(keyValue)
      return "done"
    }

    const orphans: string[] = []
    const ownershipOutcome = await projectOwnershipReconcile(desired, projects, orphans)
    if (ownershipOutcome !== "done") return ownershipOutcome
    const attempts = pendingProjects.get(keyValue)?.attempts ?? 0
    const remoteOutcome = await projectRemoteReconcile(desired, projects, attempts)
    if (remoteOutcome !== "done") {
      // A failing or partial replacement must leave the old DNS entries in
      // place; orphan deletions run only after every private hostname
      // reconciles and persists.
      return remoteOutcome
    }
    // No replacements means no split-DNS work was needed. Otherwise every
    // replacement is durably tracked before cleanup can pass its final guard.
    if (!runIsCurrent(keyValue, sequence)) return "done"
    const cleanupOutcome = await projectOrphansAttempt(orphans, keyValue, sequence, desired)
    if (cleanupOutcome !== "done") return cleanupOutcome
    const resolverOutcome = await resolverConverge(projects)
    if (resolverOutcome !== "done") return resolverOutcome
    if (runIsCurrent(keyValue, sequence)) {
      // Claim errors describe still-present invalid hostnames and survive
      // successful runs; they clear when the claim validates again, when the
      // project stops listing the hostname, or when the project is deleted.
      const currentPrivate = new Set(privateHostnames(desired))
      statusErrorsClear(
        (entry) =>
          entry.owner === desired.owner &&
          entry.project === desired.name &&
          (entry.operation !== "claim" || entry.hostname === undefined || !currentPrivate.has(entry.hostname)),
      )
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
    void freshR
    let allOk = true
    for (const orphanKey of orphans) {
      if (stopped) return "done"
      if (!runIsCurrent(keyValue, sequence)) return "done"
      const outcome = await deletionAttempt(orphanKey, { keyValue, sequence, project })
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
    const hosts = state.hosts.filter((host) => host.projectKeys.some((key) => projectKeyEqual(key, projectKey)))
    const orphans: string[] = []
    for (const host of hosts) {
      if (stopped) return "done"
      const owners = currentOwners(host, projectKey, projects)
      if (owners.length === 0) {
        deletionSchedule(host.hostname)
        orphans.push(host.hostname)
        continue
      }
      if (!(await trackingHostOwnersSet(host, owners))) return "failed"
    }
    // Project deletion cleans up without waiting for replacements.
    const cleanupOutcome = await projectOrphansAttempt(orphans, keyValue, sequence)
    if (cleanupOutcome !== "done") return cleanupOutcome
    return resolverConverge(projects)
  }

  async function drain(force: boolean): Promise<void> {
    if (!started || stopped || !active) return
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
        ([key, retry]) => pendingDue(retry) || (force && !forcedProjects.has(key) && retry.attempts === 0),
      )
      if (dueDeletion === undefined && dueProject === undefined) return
      if (dueDeletion !== undefined && (dueProject === undefined || dueDeletion[1].sequence < dueProject[1].sequence)) {
        await trackedHostDeletionRun(dueDeletion[0])
        continue
      }
      const retry = dueProject![1]
      // Force wakes each fresh project once, not repeatedly within this
      // drain: backoff retries must still honor their retry deadline.
      forcedProjects.add(dueProject![0])
      const outcome = await projectRun(dueProject![0], retry.sequence)
      if (
        (outcome === "failed" || outcome === "deferred") &&
        pendingProjects.get(dueProject![0])?.sequence === retry.sequence
      )
        retryProject(dueProject![0], retry)
      // A project with unavailable credentials or an inaccessible tailnet must
      // not prevent unrelated owners' projects from reconciling.
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
      if (stopped) return
      if (hasDueWork()) {
        drainSchedule()
        return
      }
      // The drain settled with no deferred work left: stop ticking until a
      // project command queues new work. Deferred retries re-arm the timer
      // through retryProject/retryDeletion.
      if (queueIdle()) intervalRelease()
      else intervalEnsure()
    })
  }

  function projectQueueSet(project: Project): void {
    if (!active || !started || stopped) return
    // No timer arm here: the drain below runs immediately, and any deferral
    // inside it re-arms the retry timer itself.
    const key = projectKeyValue(project)
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
    projectQueueSet(project)
  }

  function projectEditAfterPersistence(_previous: Project, project: Project): void {
    projectQueueSet(project)
  }

  function projectDeleteAfterPersistence(project: Project): void {
    if (!active || !started || stopped) return
    // No timer arm here: the drain below runs immediately, and any deferral
    // inside it re-arms the retry timer itself.
    const key = projectKeyValue(project)
    desiredProjects.delete(key)
    pendingProjects.set(key, {
      attempts: 0,
      nextAt: 0,
      sequence: nextSequence++,
    })
    drainSchedule()
  }

  function status(): ProjectRegistryDaemonPrivateDnsStatus {
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
    const parsed = a.safeParse(projectRegistryDaemonPrivateDnsStatusSchema, snapshot)
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
    if (stopped) return createResultError(op, "Private DNS queue has stopped")
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
    intervalClear()
    pendingProjects.clear()
    pendingDeletions.clear()
    const current = drainPromise
    const startup = startupPromise
    const wait = Promise.all([current, startup].filter((value): value is Promise<void> => value !== undefined))
    shutdownPromise = wait.then(
      () => createResult(undefined),
      () => createResultError(op, "Private DNS queue shutdown failed"),
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
