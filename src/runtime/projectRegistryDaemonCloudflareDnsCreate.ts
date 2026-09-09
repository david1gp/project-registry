import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { CloudflareDnsFetch } from "../cloudflare/CloudflareDnsFetch.js"
import type { CloudflareDnsReconcileResult } from "../cloudflare/CloudflareDnsReconcileResult.js"
import type { CloudflareDnsTrackedRecord } from "../cloudflare/CloudflareDnsTrackedRecord.js"
import { cloudflareDnsDeleteById } from "../cloudflare/cloudflareDnsDeleteById.js"
import { cloudflareDnsReconcile } from "../cloudflare/cloudflareDnsReconcile.js"
import type { Project } from "../project/Project.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import type { ProjectKey } from "../project/projectKey.js"
import type { ProjectRegistryDaemonCloudflareDnsTracking } from "./ProjectRegistryDaemonCloudflareDnsTracking.js"
import type { ProjectRegistryDaemonCloudflareDnsTrackingState } from "./ProjectRegistryDaemonCloudflareDnsTrackingState.js"

const reconcileIntervalMs = 1_000
const retryBaseMs = 1_000
const retryMaximumMs = 60_000

type ProjectCreateOptions = {
  noDns: boolean
}

type ProjectSnapshot = readonly Project[] | undefined

type RetryState = {
  attempts: number
  nextAt: number
  sequence: number
}

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

function hostnames(project: Project): string[] {
  if (project.caddy === undefined || project.caddy === null || project.caddy.disabled) return []
  const values = new Set<string>()
  for (const domain of project.caddy.domains) {
    const normalized = projectDomainNormalize(domain)
    if (normalized !== "") values.add(normalized)
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

function projectKeysEqual(left: readonly ProjectKey[], right: readonly ProjectKey[]): boolean {
  if (left.length !== right.length) return false
  return left.every((key, index) => projectKeyEqual(key, right[index]!))
}

function uniqueProjectKeys(projectKeys: readonly ProjectKey[]): ProjectKey[] {
  const seen = new Set<string>()
  const unique: ProjectKey[] = []
  for (const projectKey of projectKeys) {
    const value = projectKeyValue(projectKey)
    if (seen.has(value)) continue
    seen.add(value)
    unique.push({ ...projectKey })
  }
  return unique
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
      projectKeys: record.projectKeys.map((projectKey) => ({ ...projectKey })),
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
    projectKeys: uniqueProjectKeys(projectKeys),
  }
}

export function projectRegistryDaemonCloudflareDnsCreate(options: {
  enabled: boolean
  token?: string
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
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Cloudflare DNS options are required")
  }
  if (typeof options.enabled !== "boolean") return createResultError(op, "Cloudflare DNS enabled flag is invalid")
  if (options.token !== undefined && (typeof options.token !== "string" || options.token.trim() !== options.token)) {
    return createResultError(op, "Cloudflare API token is invalid")
  }
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

  const active = options.enabled && options.token !== undefined && options.token.length > 0
  const pending = new Map<string, RetryState>()
  const desiredProjects = new Map<string, Project>()
  const pendingDeletions = new Map<string, RetryState>()
  const controller = new AbortController()
  const logger = options.logger ?? ((message: string) => console.info(message))
  const clock = options.clock ?? Date.now
  let state = stateEmpty()
  let trackingBlocked = false
  let started = false
  let stopped = false
  let intervalHandle: unknown
  let drainPromise: Promise<void> | undefined
  let startupPromise: Promise<void> | undefined
  let startupRetry: RetryState | undefined
  let nextSequence = 0
  let shutdownPromise: PromiseResult<void> | undefined

  function log(message: string): void {
    try {
      logger(message)
    } catch {
      // Background logging must not affect project mutations or queue shutdown.
    }
  }

  function retryFor(map: Map<string, RetryState>, key: string): RetryState {
    return map.get(key) ?? { attempts: 0, nextAt: 0, sequence: nextSequence++ }
  }

  function retryProject(key: string, retry: RetryState, deferred: boolean): void {
    const attempts = deferred ? retry.attempts : retry.attempts + 1
    pending.set(key, {
      attempts,
      nextAt: clock() + (deferred ? retryBaseMs : retryDelay(attempts)),
      sequence: retry.sequence,
    })
  }

  function retryDeletion(key: string): void {
    const retry = retryFor(pendingDeletions, key)
    const attempts = retry.attempts + 1
    pendingDeletions.set(key, { attempts, nextAt: clock() + retryDelay(attempts), sequence: retry.sequence })
  }

  function due(retry: RetryState): boolean {
    return retry.nextAt <= clock()
  }

  async function projectsCurrent(): Promise<Result<ProjectSnapshot>> {
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

  async function trackingWrite(next: ProjectRegistryDaemonCloudflareDnsTrackingState): Promise<boolean> {
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

  async function trackingInitialize(): Promise<void> {
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

    const projectsR = await projectsCurrent()
    if (!projectsR.success || stopped) {
      startupRetry = { attempts: 1, nextAt: clock() + retryDelay(1), sequence: nextSequence++ }
      return
    }
    if (projectsR.data !== undefined) {
      const next = stateCopy(state)
      let changed = false
      for (const record of next.records) {
        const owners = projectKeysForHostname(projectsR.data, projectDomainNormalize(record.name))
        if (projectKeysEqual(record.projectKeys, owners)) continue
        record.projectKeys = owners
        changed = true
      }
      if (changed && !(await trackingWrite(next))) {
        startupRetry = { attempts: 1, nextAt: clock() + retryDelay(1), sequence: nextSequence++ }
        return
      }
    }
    startupRetry = undefined
    for (const record of state.records) {
      if (record.projectKeys.length === 0) {
        const key = recordKeyValue(record)
        pendingDeletions.set(key, retryFor(pendingDeletions, key))
      }
    }
  }

  async function trackingOwnersSet(
    record: CloudflareDnsTrackedRecord,
    projectKeys: readonly ProjectKey[],
  ): Promise<boolean> {
    const owners = uniqueProjectKeys(projectKeys)
    if (projectKeysEqual(record.projectKeys, owners)) return true
    const next = stateCopy(state)
    const current = next.records.find((entry) => recordKeyValue(entry) === recordKeyValue(record))
    if (current === undefined) return true
    current.projectKeys = owners
    return trackingWrite(next)
  }

  async function deleteTracked(recordKey: string): Promise<QueueOutcome> {
    const record = state.records.find((entry) => recordKeyValue(entry) === recordKey)
    if (record === undefined || record.projectKeys.length > 0) {
      pendingDeletions.delete(recordKey)
      return "done"
    }
    if (!active || stopped) {
      pendingDeletions.delete(recordKey)
      return "done"
    }
    let result: Awaited<ReturnType<typeof cloudflareDnsDeleteById>>
    try {
      result = await cloudflareDnsDeleteById({
        token: options.token!,
        record,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    } catch {
      log(`cloudflare DNS deletion outcome=failure recordId=${record.id} reason=unexpected-error`)
      retryDeletion(recordKey)
      return "failed"
    }
    if (!result.success) {
      log(`cloudflare DNS deletion outcome=failure recordId=${record.id} reason=${result.errorMessage}`)
      retryDeletion(recordKey)
      return "failed"
    }
    if (stopped) return "done"
    const next = stateCopy(state)
    next.records = next.records.filter((entry) => recordKeyValue(entry) !== recordKey)
    if (!(await trackingWrite(next))) {
      retryDeletion(recordKey)
      return "failed"
    }
    pendingDeletions.delete(recordKey)
    return "done"
  }

  async function projectRun(keyValue: string, sequence: number): Promise<QueueOutcome> {
    const project = desiredProjects.get(keyValue)
    const projectsR = await projectsCurrent()
    if (!projectsR.success && options.repositoryProjectsCurrent !== undefined) return "failed"
    const projects = projectsR.success ? projectsR.data : undefined
    const projectKey: ProjectKey = {
      owner: keyValue.split("\u0000")[0] ?? "",
      name: keyValue.split("\u0000")[1] ?? "",
    }

    if (options.tracking !== undefined) {
      const ownedRecords = state.records.filter((record) =>
        record.projectKeys.some((owner) => projectKeyEqual(owner, projectKey)),
      )
      const currentHostnames = project === undefined ? new Set<string>() : new Set(hostnames(project))
      for (const record of ownedRecords) {
        const hostname = projectDomainNormalize(record.name)
        if (currentHostnames.has(hostname)) continue
        const owners =
          projects === undefined
            ? record.projectKeys.filter((owner) => !projectKeyEqual(owner, projectKey))
            : projectKeysForHostname(projects, hostname).filter((owner) => !projectKeyEqual(owner, projectKey))
        if (!(await trackingOwnersSet(record, owners))) return "failed"
        const current = state.records.find((entry) => recordKeyValue(entry) === recordKeyValue(record))
        if (current !== undefined && current.projectKeys.length === 0) {
          const recordKey = recordKeyValue(current)
          pendingDeletions.set(recordKey, retryFor(pendingDeletions, recordKey))
        }
      }
    }

    if (project === undefined) {
      if (pending.get(keyValue)?.sequence === sequence) pending.delete(keyValue)
      return "done"
    }

    const address = options.serverIpCurrent()
    if (address === undefined || address === "") return "deferred"
    for (const hostname of hostnames(project)) {
      if (stopped) return "done"
      let reconcileR: Awaited<ReturnType<typeof cloudflareDnsReconcile>>
      try {
        reconcileR = await cloudflareDnsReconcile({
          token: options.token!,
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
      const owners =
        projects === undefined
          ? uniqueProjectKeys([...(existing?.projectKeys ?? []), projectKey])
          : uniqueProjectKeys(projectKeysForHostname(projects, hostname))
      const next = stateCopy(state)
      const tracked = trackedRecordCreate(reconcileR.data, owners)
      const index = next.records.findIndex((record) => recordKeyValue(record) === recordKeyValue(tracked))
      if (index < 0) next.records.push(tracked)
      else next.records[index] = tracked
      if (options.tracking !== undefined && !(await trackingWrite(next))) return "failed"
      pendingDeletions.delete(recordKeyValue(tracked))
    }
    if (pending.get(keyValue)?.sequence === sequence) pending.delete(keyValue)
    return "done"
  }

  async function drain(force: boolean): Promise<void> {
    if (!started || stopped || (!active && options.tracking === undefined)) return
    if (startupPromise !== undefined) await startupPromise
    if (stopped || trackingBlocked) return
    while (!stopped) {
      if (startupRetry !== undefined && due(startupRetry)) {
        startupRetry = undefined
        await trackingInitialize()
        if (startupRetry !== undefined || trackingBlocked) return
      }
      const dueDeletion = [...pendingDeletions.entries()].find(([, retry]) => due(retry))
      const dueProject = [...pending.entries()].find(
        ([, retry]) => due(retry) || (force && retry.attempts === 0 && options.serverIpCurrent() !== undefined),
      )
      if (dueDeletion === undefined && dueProject === undefined) return
      if (dueDeletion !== undefined && (dueProject === undefined || dueDeletion[1].sequence < dueProject[1].sequence)) {
        await deleteTracked(dueDeletion[0])
        continue
      }
      const [key, retry] = dueProject!
      const outcome = await projectRun(key, retry.sequence)
      if (outcome === "failed" && pending.get(key)?.sequence === retry.sequence) retryProject(key, retry, false)
      if (outcome === "deferred" && pending.get(key)?.sequence === retry.sequence) retryProject(key, retry, true)
      if (outcome !== "done") return
    }
  }

  function hasDueWork(): boolean {
    if (trackingBlocked) return false
    return (
      (startupRetry !== undefined && due(startupRetry)) ||
      [...pendingDeletions.values()].some((retry) => due(retry)) ||
      [...pending.values()].some((retry) => due(retry))
    )
  }

  function drainSchedule(force = false): void {
    if (!started || stopped || drainPromise !== undefined) return
    const current = Promise.resolve()
      .then(() => drain(force))
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
    const key = projectKeyValue(project)
    desiredProjects.set(key, project)
    pending.set(key, { attempts: 0, nextAt: 0, sequence: nextSequence++ })
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
    const key = projectKeyValue(project)
    desiredProjects.delete(key)
    pending.set(key, { attempts: 0, nextAt: 0, sequence: nextSequence++ })
    drainSchedule()
  }

  function start(): Result<void> {
    if (started) return createResult(undefined)
    if (stopped) return createResultError(op, "Cloudflare DNS queue has stopped")
    if (active) {
      try {
        intervalHandle = options.timer.setInterval(() => drainSchedule(true), reconcileIntervalMs)
      } catch {
        return createResultError(op, "Cloudflare DNS timer setup failed")
      }
    }
    started = true
    startupPromise = Promise.resolve()
      .then(trackingInitialize)
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
    pending.clear()
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
