import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import type { ProjectKey } from "../project/projectKey.js"
import { projectLocalCaddyEntries } from "../project/projectLocalCaddyEntries.js"
import {
  projectPrivateTlsChallengeResolversDefault,
  projectPrivateTlsChallengeResolversValidate,
  projectPrivateTlsEnrollmentPlanCreate,
} from "../project/projectPrivateTlsEnrollment.js"
import type { ProjectPrivateTlsGateSnapshot } from "../project/projectPrivateTlsGate.js"
import { projectPrivateTlsTokenResolve } from "../project/projectPrivateTlsTokenSelect.js"
import type { ProjectRegistryDaemonPrivateTlsStatus } from "./projectRegistryDaemonPrivateTlsStatusSchema.js"

// Retry wake-up cadence. Tracking is event-driven: project commands drain
// immediately and this timer only exists to retry deferred enrollment and
// trust proof. It is disarmed whenever nothing is waiting, so a reconciled
// daemon performs no periodic repository reads at all.
const retryTickMs = 1_000
const retryBaseMs = 1_000
const retryMaximumMs = 60_000
const maxStatusErrors = 20

type RetryState = {
  attempts: number
  nextAt: number
}

type StatusErrorEntry = {
  owner?: string
  hostname?: string
  operation: string
  errorMessage: string
  attempts: number
  occurredAt: number
  nextRetryAt?: number
}

type EnrolledHost = {
  owner: string
  zone: string
}

function projectKeyValue(project: ProjectKey): string {
  return `${project.owner}\u0000${project.name}`
}

function retryDelay(attempts: number): number {
  return Math.min(retryMaximumMs, retryBaseMs * 2 ** Math.min(attempts, 6))
}

function fieldEscape(value: string): string {
  return value.replace(/[\s=]+/g, "_")
}

function privateHostnames(project: Project): string[] {
  const values = new Set<string>()
  for (const entry of projectLocalCaddyEntries(project)) {
    if (entry.caddy.disabled) continue
    if (entry.caddy.networkVisibility !== "private") continue
    for (const domain of entry.caddy.domains) {
      const normalized = projectDomainNormalize(domain)
      if (normalized !== "") values.add(normalized)
    }
  }
  return [...values]
}

/**
 * Track per-host private-Caddy TLS enrollment readiness. Desired set =
 * registry private hostnames grouped by claiming owner; multi-level names
 * enroll per host with the claiming owner's Cloudflare token (resolved but
 * never logged), single-level names stay wildcard-covered and never trigger
 * enrollment or a credential lookup. Missing tokens defer with backoff like
 * the DNS queues; claim rejections surface as persistent errors.
 *
 * Trusted proof (mirroring the `~/ds` `leoBatchTlsPrepare` ordering):
 * every desired name is probed for a genuinely trusted handshake (chain
 * verified, never `--insecure`; any served content is fine) and only
 * proven names are published to the gate snapshot. The private regenerate
 * hook (`caddyConfigPrivateTlsReconcile`, fed by `gateState`) installs
 * the rendered enrollment set
 * (`projectPrivateTlsAutomationRender`: per-zone DNS-01 issuer policies
 * plus the `certificates.automate` loader) onto the zero-route baseline
 * and withholds routes for unproven names — enroll first, prove, only
 * then move routes. The loader enrolls certificates even with zero
 * routes, so withholding never deadlocks proof; the next regenerate
 * (project change, manual, or periodic) serves newly proven names.
 */
export function projectRegistryDaemonPrivateTlsCreate(options: {
  enabled: boolean
  challengeResolvers?: readonly string[]
  privateListenerAddresses?: readonly string[]
  credentialResolve?: (owner: string) => PromiseResult<string | undefined>
  trustedProbe?: (hostname: string) => PromiseResult<"trusted">
  gateState?: { update(snapshot: ProjectPrivateTlsGateSnapshot): void }
  repositoryProjectsCurrent?: () => PromiseResult<readonly Project[]>
  logger?: (message: string) => void
  clock?: () => number
  timer: {
    setInterval(callback: () => void, delayMs: number): unknown
    clearInterval(handle: unknown): void
  }
}): Result<{
  start(): Result<void>
  shutdown(): PromiseResult<void>
  status(): ProjectRegistryDaemonPrivateTlsStatus
  projectCreateAfterPersistence(project: Project): void
  projectEditAfterPersistence(previous: Project, project: Project): void
  projectDeleteAfterPersistence(project: Project): void
}> {
  const op = "projectRegistryDaemonPrivateTlsCreate"
  if (typeof options !== "object" || options === null) return createResultError(op, "Private TLS options are required")
  if (typeof options.enabled !== "boolean") return createResultError(op, "Private TLS enabled flag is invalid")
  if (options.challengeResolvers !== undefined && !Array.isArray(options.challengeResolvers)) {
    return createResultError(op, "Private TLS challenge resolvers are invalid")
  }
  if (options.privateListenerAddresses !== undefined && !Array.isArray(options.privateListenerAddresses)) {
    return createResultError(op, "Private TLS private listener addresses are invalid")
  }
  const resolversR = projectPrivateTlsChallengeResolversValidate(
    options.challengeResolvers === undefined
      ? [...projectPrivateTlsChallengeResolversDefault]
      : [...options.challengeResolvers],
    {
      ...(options.privateListenerAddresses === undefined ? {} : { privateAddresses: options.privateListenerAddresses }),
      op,
    },
  )
  if (!resolversR.success) return resolversR
  if (options.credentialResolve !== undefined && typeof options.credentialResolve !== "function") {
    return createResultError(op, "Private TLS credential resolver is invalid")
  }
  if (options.trustedProbe !== undefined && typeof options.trustedProbe !== "function") {
    return createResultError(op, "Private TLS trust probe is invalid")
  }
  if (
    options.gateState !== undefined &&
    (typeof options.gateState !== "object" ||
      options.gateState === null ||
      typeof (options.gateState as { update?: unknown }).update !== "function")
  ) {
    return createResultError(op, "Private TLS gate state is invalid")
  }
  if (options.gateState !== undefined && options.trustedProbe === undefined) {
    return createResultError(op, "Private TLS gate state requires a trust probe; nothing could ever be proven")
  }
  if (options.repositoryProjectsCurrent !== undefined && typeof options.repositoryProjectsCurrent !== "function") {
    return createResultError(op, "Private TLS project snapshot accessor is invalid")
  }
  if (options.logger !== undefined && typeof options.logger !== "function") {
    return createResultError(op, "Private TLS logger is invalid")
  }
  if (typeof options.timer !== "object" || options.timer === null) {
    return createResultError(op, "Private TLS timer is required")
  }
  if (typeof options.timer.setInterval !== "function" || typeof options.timer.clearInterval !== "function") {
    return createResultError(op, "Private TLS timer is invalid")
  }

  const active = options.enabled
  const challengeResolvers = resolversR.data
  const knownProjects = new Map<string, Project>()
  const enrolled = new Map<string, EnrolledHost>()
  const proven = new Map<string, EnrolledHost>()
  const ownerRetries = new Map<string, RetryState>()
  const proofRetries = new Map<string, RetryState>()
  const statusErrors = new Map<string, StatusErrorEntry>()
  const logger = options.logger ?? ((message: string) => console.info(message))
  const clock = options.clock ?? Date.now
  let wildcardCovered: string[] = []
  let lastSuccessAt: number | undefined
  let started = false
  let stopped = false
  let intervalHandle: unknown
  let drainPromise: Promise<void> = Promise.resolve()
  let shutdownPromise: PromiseResult<void> | undefined
  let snapshotFailed = false

  function log(message: string): void {
    try {
      logger(message)
    } catch {
      // Logging must not affect project mutations or queue shutdown.
    }
  }

  function logEvent(
    event: "enrollment" | "release" | "snapshot" | "credential" | "proof",
    outcome: "success" | "failure" | "deferred",
    fields: {
      owner?: string
      hostname?: string
      zone?: string
      operation?: string
      attempt?: number
      nextRetryMs?: number
      reason?: string
    },
  ): void {
    const parts = [`private TLS ${event} outcome=${outcome}`]
    if (fields.owner !== undefined) parts.push(`owner=${fieldEscape(fields.owner)}`)
    if (fields.hostname !== undefined) parts.push(`hostname=${fieldEscape(fields.hostname)}`)
    if (fields.zone !== undefined) parts.push(`zone=${fieldEscape(fields.zone)}`)
    if (fields.operation !== undefined) parts.push(`operation=${fieldEscape(fields.operation)}`)
    if (fields.attempt !== undefined) parts.push(`attempt=${fields.attempt}`)
    if (fields.nextRetryMs !== undefined) parts.push(`nextRetryMs=${fields.nextRetryMs}`)
    if (fields.reason !== undefined) parts.push(`reason=${fieldEscape(fields.reason)}`)
    log(parts.join(" "))
  }

  function statusErrorKey(entry: Pick<StatusErrorEntry, "operation" | "owner" | "hostname">): string {
    return [entry.operation, entry.owner ?? "", entry.hostname ?? ""].join("\u0000")
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

  function claimErrorRecord(owner: string, hostname: string, message: string): void {
    const exists = [...statusErrors.values()].some(
      (entry) =>
        entry.operation === "claim" &&
        entry.owner === owner &&
        entry.hostname === hostname &&
        entry.errorMessage === message,
    )
    if (!exists) {
      statusErrorUpsert({
        owner,
        hostname,
        operation: "claim",
        errorMessage: message,
        attempts: 0,
        occurredAt: clock(),
      })
    }
    logEvent("enrollment", "failure", { owner, hostname, operation: "claim", reason: message })
  }

  function ownerRetry(owner: string): RetryState {
    return ownerRetries.get(owner) ?? { attempts: 0, nextAt: 0 }
  }

  async function snapshotCurrent(): Promise<{ projects: readonly Project[] } | { error: string }> {
    if (options.repositoryProjectsCurrent === undefined) return { projects: [...knownProjects.values()] }
    let snapshot: Awaited<ReturnType<NonNullable<typeof options.repositoryProjectsCurrent>>>
    try {
      snapshot = await options.repositoryProjectsCurrent()
    } catch {
      return { error: "Private TLS project snapshot could not be read" }
    }
    if (typeof snapshot !== "object" || snapshot === null || typeof snapshot.success !== "boolean") {
      return { error: "Private TLS project snapshot is invalid" }
    }
    if (!snapshot.success) return { error: "Private TLS project snapshot could not be read" }
    if (!Array.isArray(snapshot.data)) return { error: "Private TLS project snapshot is invalid" }
    knownProjects.clear()
    for (const project of snapshot.data) {
      if (typeof project === "object" && project !== null) {
        knownProjects.set(projectKeyValue(project as ProjectKey), project)
      }
    }
    return { projects: snapshot.data }
  }

  async function drainOnce(): Promise<void> {
    if (!active || stopped) return
    const snapshot = await snapshotCurrent()
    if ("error" in snapshot) {
      statusErrorUpsert({ operation: "snapshot", errorMessage: snapshot.error, attempts: 0, occurredAt: clock() })
      logEvent("snapshot", "failure", { operation: "snapshot", reason: snapshot.error })
      snapshotFailed = true
      return
    }
    snapshotFailed = false
    statusErrorsClear((entry) => entry.operation === "snapshot")

    const desiredByOwner = new Map<string, Set<string>>()
    for (const project of snapshot.projects) {
      if (typeof project.owner !== "string" || project.owner.trim() === "") continue
      let owned = desiredByOwner.get(project.owner)
      if (owned === undefined) {
        owned = new Set<string>()
        desiredByOwner.set(project.owner, owned)
      }
      for (const hostname of privateHostnames(project)) owned.add(hostname)
    }

    const desiredEnroll = new Map<string, { owner: string; zone: string }>()
    const desiredWildcard = new Set<string>()
    const desiredOwner = new Map<string, { owner: string; zone: string }>()
    const claimedOwners = new Set<string>()
    for (const [owner, hostnames] of desiredByOwner) {
      for (const hostname of hostnames) {
        const planR = projectPrivateTlsEnrollmentPlanCreate(owner, [hostname], op)
        if (!planR.success) {
          claimErrorRecord(owner, hostname, planR.errorMessage)
          continue
        }
        claimedOwners.add(owner)
        const host = planR.data.hosts[0]
        if (host === undefined) continue
        desiredOwner.set(host.hostname, { owner, zone: host.zone })
        if (host.enrollment === "wildcard") {
          desiredWildcard.add(host.hostname)
          statusErrorsClear(
            (entry) =>
              entry.owner === owner &&
              entry.hostname === host.hostname &&
              entry.operation !== "claim" &&
              entry.operation !== "tls-proof",
          )
          continue
        }
        desiredEnroll.set(host.hostname, { owner, zone: host.zone })
      }
    }
    statusErrorsClear(
      (entry) => entry.operation === "claim" && !desiredByOwner.get(entry.owner ?? "")?.has(entry.hostname ?? ""),
    )

    for (const [hostname, entry] of [...enrolled]) {
      if (!desiredEnroll.has(hostname)) {
        enrolled.delete(hostname)
        logEvent("release", "success", { owner: entry.owner, hostname, zone: entry.zone })
      }
    }
    wildcardCovered = [...desiredWildcard].sort()

    const pending = new Set<string>()
    for (const [hostname, entry] of desiredEnroll) {
      if (enrolled.has(hostname)) {
        statusErrorsClear((value) => value.owner === entry.owner && value.operation === "tls-token")
        continue
      }
      const retry = ownerRetry(entry.owner)
      if (retry.nextAt > clock()) {
        pending.add(entry.owner)
        continue
      }
      if (options.credentialResolve === undefined) {
        pending.add(entry.owner)
        continue
      }
      const tokenR = await projectPrivateTlsTokenResolve({
        owner: entry.owner,
        hostname,
        credentialResolve: options.credentialResolve,
        op,
      })
      if (!tokenR.success) {
        pending.add(entry.owner)
        const attempts = retry.attempts + 1
        const nextRetryMs = retryDelay(attempts)
        ownerRetries.set(entry.owner, { attempts, nextAt: clock() + nextRetryMs })
        statusErrorUpsert({
          owner: entry.owner,
          operation: "tls-token",
          errorMessage: "Private TLS credentials could not be loaded",
          attempts,
          occurredAt: clock(),
          nextRetryAt: clock() + nextRetryMs,
        })
        logEvent("credential", "deferred", {
          owner: entry.owner,
          hostname,
          operation: "tls-token",
          attempt: attempts,
          nextRetryMs,
        })
        continue
      }
      if (tokenR.data.token === undefined) {
        pending.add(entry.owner)
        const attempts = retry.attempts + 1
        const nextRetryMs = retryDelay(attempts)
        ownerRetries.set(entry.owner, { attempts, nextAt: clock() + nextRetryMs })
        statusErrorUpsert({
          owner: entry.owner,
          operation: "tls-token",
          errorMessage: `Private TLS credentials for owner "${entry.owner}" are missing; cannot enroll ${hostname}`,
          attempts,
          occurredAt: clock(),
          nextRetryAt: clock() + nextRetryMs,
        })
        logEvent("credential", "deferred", {
          owner: entry.owner,
          hostname,
          zone: entry.zone,
          operation: "tls-token",
          attempt: attempts,
          nextRetryMs,
        })
        continue
      }
      ownerRetries.delete(entry.owner)
      statusErrorsClear((value) => value.owner === entry.owner && value.operation === "tls-token")
      const ownerHosts = [...desiredEnroll].filter(([, candidate]) => candidate.owner === entry.owner)
      for (const [enrollHostname, enrollEntry] of ownerHosts) {
        if (!enrolled.has(enrollHostname)) {
          enrolled.set(enrollHostname, enrollEntry)
          logEvent("enrollment", "success", {
            owner: enrollEntry.owner,
            hostname: enrollHostname,
            zone: enrollEntry.zone,
          })
        }
      }
      lastSuccessAt = clock()
    }
    for (const owner of claimedOwners) {
      if (pending.has(owner)) continue
      const outstanding = [...desiredEnroll].some(
        ([hostname, entry]) => entry.owner === owner && !enrolled.has(hostname),
      )
      if (!outstanding) ownerRetries.delete(owner)
    }

    const probe = options.trustedProbe
    if (probe !== undefined) {
      for (const [hostname, identity] of [...proven]) {
        if (!desiredOwner.has(hostname)) {
          proven.delete(hostname)
          proofRetries.delete(hostname)
          statusErrorsClear((value) => value.hostname === hostname && value.operation === "tls-proof")
          logEvent("release", "success", { owner: identity.owner, hostname, zone: identity.zone })
        }
      }
      for (const [hostname, identity] of desiredOwner) {
        if (proven.has(hostname)) {
          statusErrorsClear((value) => value.hostname === hostname && value.operation === "tls-proof")
          continue
        }
        const retry = proofRetries.get(hostname) ?? { attempts: 0, nextAt: 0 }
        if (retry.nextAt > clock()) continue
        let probed: unknown
        try {
          probed = await probe(hostname)
        } catch {
          probed = undefined
        }
        const trusted =
          typeof probed === "object" &&
          probed !== null &&
          (probed as { success?: unknown }).success === true &&
          (probed as { data?: unknown }).data === "trusted"
        if (trusted) {
          proven.set(hostname, identity)
          proofRetries.delete(hostname)
          statusErrorsClear((value) => value.hostname === hostname && value.operation === "tls-proof")
          logEvent("proof", "success", { owner: identity.owner, hostname, zone: identity.zone })
          lastSuccessAt = clock()
          continue
        }
        const attempts = retry.attempts + 1
        const nextRetryMs = retryDelay(attempts)
        proofRetries.set(hostname, { attempts, nextAt: clock() + nextRetryMs })
        statusErrorUpsert({
          owner: identity.owner,
          hostname,
          operation: "tls-proof",
          errorMessage: `Private TLS trust for "${hostname}" is not proven; refusing to serve before a trusted handshake`,
          attempts,
          occurredAt: clock(),
          nextRetryAt: clock() + nextRetryMs,
        })
        logEvent("proof", "deferred", {
          owner: identity.owner,
          hostname,
          zone: identity.zone,
          operation: "tls-proof",
          attempt: attempts,
          nextRetryMs,
        })
      }
    }

    if (options.gateState !== undefined) {
      try {
        options.gateState.update({
          enrolled: [...enrolled.keys()].sort(),
          wildcardCovered: [...wildcardCovered],
          proven: [...proven.keys()].sort(),
        })
      } catch {
        // A failing gate publish must not break the drain; the last snapshot stands.
      }
    }
  }

  function intervalClear(): void {
    if (intervalHandle === undefined) return
    try {
      options.timer.clearInterval(intervalHandle)
    } catch {
      // Shutdown continues even when the timer refuses to clear.
    }
    intervalHandle = undefined
  }

  function intervalRelease(): void {
    if (intervalHandle === undefined) return
    intervalClear()
  }

  function intervalEnsure(): void {
    if (!active || stopped || intervalHandle !== undefined) return
    try {
      intervalHandle = options.timer.setInterval(intervalTick, retryTickMs)
    } catch {
      logEvent("snapshot", "failure", { operation: "timer", reason: "retry-timer-unavailable" })
      statusErrorUpsert({
        operation: "timer",
        errorMessage: "Private TLS retry timer unavailable",
        attempts: 0,
        occurredAt: clock(),
      })
    }
  }

  function retriesDue(): boolean {
    const now = clock()
    for (const retry of ownerRetries.values()) {
      if (retry.nextAt <= now) return true
    }
    for (const retry of proofRetries.values()) {
      if (retry.nextAt <= now) return true
    }
    return false
  }

  function queueIdle(): boolean {
    return ownerRetries.size === 0 && proofRetries.size === 0 && !snapshotFailed
  }

  function intervalTick(): void {
    if (!active || stopped || !started) return
    if (queueIdle()) {
      // Nothing is waiting for enrollment, proof, or a snapshot retry:
      // stop ticking until a project command drains again.
      intervalRelease()
      return
    }
    if (!snapshotFailed && !retriesDue()) return
    drainKick()
  }

  function settleTimer(): void {
    if (stopped) return
    // Deferred enrollment and trust proof re-arm the retry timer; a clean
    // drain disarms it so idle tracking performs no repository reads.
    if (queueIdle()) intervalRelease()
    else intervalEnsure()
  }

  function drainKick(): void {
    if (!active || stopped || !started) return
    drainPromise = drainPromise.then(
      () => drainOnce(),
      () => drainOnce(),
    )
    void drainPromise.then(
      () => settleTimer(),
      () => settleTimer(),
    )
  }

  function projectForget(project: Project): void {
    knownProjects.delete(projectKeyValue({ owner: project.owner, name: project.name }))
  }

  return createResult({
    start(): Result<void> {
      if (stopped) return createResultError(op, "Private TLS queue is shut down")
      if (started) return createResultError(op, "Private TLS queue is already started")
      started = true
      // No timer arm here: the drain below runs immediately, and settleTimer
      // arms the retry timer only when enrollment or proof stays deferred.
      if (active) drainKick()
      return createResult(undefined)
    },
    shutdown(): PromiseResult<void> {
      if (shutdownPromise !== undefined) return shutdownPromise
      stopped = true
      intervalClear()
      shutdownPromise = drainPromise.then(
        () => createResult(undefined),
        () => createResult(undefined),
      )
      return shutdownPromise
    },
    status(): ProjectRegistryDaemonPrivateTlsStatus {
      const pendingOwners = new Set<string>()
      for (const owner of ownerRetries.keys()) pendingOwners.add(owner)
      for (const entry of statusErrors.values()) {
        if (entry.operation === "tls-token" && entry.owner !== undefined) pendingOwners.add(entry.owner)
      }
      return {
        enabled: active,
        pendingOwners: pendingOwners.size,
        enrolled: [...enrolled.keys()].sort(),
        wildcardCovered: [...wildcardCovered],
        proven: [...proven.keys()].sort(),
        challengeResolvers: [...challengeResolvers],
        ...(lastSuccessAt === undefined ? {} : { lastSuccess: lastSuccessAt }),
        errors: [...statusErrors.values()].sort((left, right) => left.occurredAt - right.occurredAt),
      }
    },
    projectCreateAfterPersistence(project: Project): void {
      if (!active || stopped) return
      knownProjects.set(projectKeyValue({ owner: project.owner, name: project.name }), project)
      drainKick()
    },
    projectEditAfterPersistence(previous: Project, project: Project): void {
      if (!active || stopped) return
      projectForget(previous)
      knownProjects.set(projectKeyValue({ owner: project.owner, name: project.name }), project)
      drainKick()
    },
    projectDeleteAfterPersistence(project: Project): void {
      if (!active || stopped) return
      projectForget(project)
      drainKick()
    },
  })
}
