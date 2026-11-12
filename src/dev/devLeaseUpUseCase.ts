import { createResult, createResultError, createResultErrorCode, type PromiseResult } from "#result"
import type { CaddyApplicationResult } from "../caddy/CaddyApplicationResult.js"
import type { Project } from "../project/Project.js"
import type { ProjectPortRange } from "../project/projectPortNext.js"
import type { ProjectService } from "../project/projectServiceSchema.js"
import type { DevCommandOverride } from "./DevCommandOverride.js"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import type { DevRoot } from "./DevRoot.js"
import { devCommandResolve } from "./devCommandResolve.js"
import { devHostnameClaimValidate } from "./devHostnameClaimValidate.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"
import { devPortAllocate } from "./devPortAllocate.js"
import { devRootDirectoryResolve } from "./devRootDirectoryResolve.js"
import { devUnitAlive } from "./devUnitAlive.js"
import { devUnitName } from "./devUnitName.js"
import { devUnitStart } from "./devUnitStart.js"
import { devUnitStop } from "./devUnitStop.js"

export const devLeaseDefaultTtlMs = 14_400_000
// Cold vite/rsbuild starts (dependency pre-bundling) routinely exceed 30s.
export const devLeaseDefaultHealthTimeoutMs = 90_000
const devLeaseDefaultHealthIntervalMs = 250

export type DevLeaseUpUseCaseOptions = {
  user: string
  name: string
  ttlMs?: number
  serviceId?: string
  projects: readonly Project[]
  portRange?: ProjectPortRange
  tracking: DevLeaseTracking
  runner: DevProcessRunner
  userResolve: (username: string) => PromiseResult<{ uid: number }>
  /** Allowed dev roots; `projectsRoot` is the legacy all-users single root. */
  roots?: readonly DevRoot[]
  rootPath?: string
  projectsRoot?: string
  commandFilesystem?: DevProjectFilesystem
  command?: DevCommandOverride
  pathValue?: string
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  clock?: () => number
  wait?: (ms: number) => Promise<void>
  defaultTtlMs?: number
  healthTimeoutMs?: number
  healthIntervalMs?: number
  regenerate: () => PromiseResult<CaddyApplicationResult>
}

const devLeaseLoopbackHost = "127.0.0.1"

type RowDevCommand = { kind: "none" } | { kind: "command"; command: string } | { kind: "service-missing" }

/**
 * The caller's own registry row may pin a per-service `dev.command`. With
 * `serviceId` that service is used (unknown service → error); without it the
 * single service carrying `dev` is used, so multi-service rows (web + api +
 * convex) work as long as exactly one service declares a dev command.
 */
function rowDevCommandFind(
  projects: readonly Project[],
  user: string,
  name: string,
  serviceId?: string,
): RowDevCommand {
  const row = projects.find((project) => project.owner === user && project.name === name)
  const services = row?.services
  const candidates = Array.isArray(services)
    ? services.filter((service): service is ProjectService => typeof service === "object" && service !== null)
    : []
  if (serviceId !== undefined) {
    const picked = candidates.find((service) => service.id === serviceId)
    if (picked === undefined) return { kind: "service-missing" }
    const command = picked.dev?.command
    return typeof command === "string" ? { kind: "command", command } : { kind: "none" }
  }
  const withDev = candidates.filter((service) => typeof service.dev?.command === "string")
  const only = withDev.length === 1 ? withDev[0]?.dev?.command : undefined
  return typeof only === "string" ? { kind: "command", command: only } : { kind: "none" }
}

function leaseKeyMatch(lease: DevLeaseRecord, user: string, name: string, serviceId?: string): boolean {
  return (
    lease.projectKey.owner === user &&
    lease.projectKey.name === name &&
    (lease.serviceId ?? undefined) === (serviceId ?? undefined)
  )
}

async function healthWait(options: {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  clock: () => number
  wait: (ms: number) => Promise<void>
  port: number
  timeoutMs: number
  intervalMs: number
}): PromiseResult<void> {
  const op = "devLeaseUp"
  const startedAt = options.clock()
  for (;;) {
    try {
      const response = await options.fetch(`http://127.0.0.1:${options.port}/`)
      try {
        await response.arrayBuffer()
      } catch {
        // Any HTTP response proves the loopback server is up; an unreadable
        // body must not fail the health wait.
      }
      return createResult(undefined)
    } catch {
      if (options.clock() - startedAt >= options.timeoutMs) {
        return createResultErrorCode(op, "dev server health check timed out", "caddy.unavailable")
      }
      await options.wait(options.intervalMs)
    }
  }
}

export function devLeaseUpUseCase(options: DevLeaseUpUseCaseOptions): PromiseResult<DevLeaseRecord> {
  const op = "devLeaseUp"
  if (typeof options !== "object" || options === null) {
    return Promise.resolve(createResultError(op, "dev up options are required"))
  }
  return upInternal(options, op)
}

async function upInternal(options: DevLeaseUpUseCaseOptions, op: string): PromiseResult<DevLeaseRecord> {
  if (options.tracking === undefined || options.runner === undefined || options.regenerate === undefined) {
    return createResultError(op, "dev up dependencies are unavailable")
  }
  if (typeof options.user !== "string" || typeof options.name !== "string" || !Array.isArray(options.projects)) {
    return createResultError(op, "dev up options are invalid")
  }
  if (typeof options.userResolve !== "function") return createResultError(op, "dev user resolution is unavailable")
  const ttlMs = options.ttlMs ?? options.defaultTtlMs ?? devLeaseDefaultTtlMs
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return createResultError(op, "dev TTL is invalid")
  const clock = options.clock ?? Date.now
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)))
  const fetch = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init))
  const healthTimeoutMs = options.healthTimeoutMs ?? devLeaseDefaultHealthTimeoutMs
  const healthIntervalMs = options.healthIntervalMs ?? devLeaseDefaultHealthIntervalMs
  const pathValue = options.pathValue ?? process.env.PATH ?? ""
  if (pathValue.trim() === "") return createResultError(op, "dev PATH is not configured")

  const stateR = await options.tracking.read()
  if (!stateR.success) return stateR
  const leases = stateR.data.leases
  const hostnameR = devHostnameClaimValidate({
    user: options.user,
    project: options.name,
    projects: options.projects,
    leases,
  })
  if (!hostnameR.success) return hostnameR
  const now = clock()

  const sibling = leases.find(
    (lease) =>
      lease.projectKey.owner === options.user &&
      lease.projectKey.name === options.name &&
      !leaseKeyMatch(lease, options.user, options.name, options.serviceId),
  )
  if (sibling !== undefined) {
    // The hostname is per project: a second service would share it.
    return createResultErrorCode(
      op,
      `dev project ${options.user}/${options.name} already runs ${sibling.serviceId === undefined ? "without a service" : `service ${sibling.serviceId}`}; run dev down first`,
      "projects.conflict",
    )
  }
  const existing = leases.find((lease) => leaseKeyMatch(lease, options.user, options.name, options.serviceId))
  let base = leases
  if (existing !== undefined) {
    const aliveR = await devUnitAlive({ runner: options.runner, unit: existing.unit })
    if (!aliveR.success) return aliveR
    if (aliveR.data) {
      const touched: DevLeaseRecord = { ...existing, lastSeenAt: now }
      const writeR = await options.tracking.write({
        version: 1,
        leases: leases.map((lease) => (lease === existing ? touched : lease)),
      })
      if (!writeR.success) return writeR
      return createResult(touched)
    }
    await devUnitStop({ runner: options.runner, unit: existing.unit })
    base = leases.filter((lease) => lease !== existing)
    const dropR = await options.tracking.write({ version: 1, leases: base })
    if (!dropR.success) return dropR
  }

  const rowCommand = rowDevCommandFind(options.projects, options.user, options.name, options.serviceId)
  if (rowCommand.kind === "service-missing") {
    return createResultErrorCode(
      op,
      `service ${options.serviceId} is not registered for ${options.user}/${options.name}`,
      "dev.not-found",
    )
  }
  const roots: readonly DevRoot[] =
    options.roots ?? (options.projectsRoot === undefined ? [] : [{ path: options.projectsRoot }])
  const directoryR = await devRootDirectoryResolve({
    roots,
    user: options.user,
    project: options.name,
    ...(options.rootPath === undefined ? {} : { rootPath: options.rootPath }),
    ...(options.commandFilesystem === undefined ? {} : { filesystem: options.commandFilesystem }),
  })
  if (!directoryR.success) return directoryR
  const portR = devPortAllocate(options.projects, base, options.portRange)
  if (!portR.success) return portR
  const commandR = await devCommandResolve({
    directory: directoryR.data.directory,
    projectsRoot: directoryR.data.root,
    ...(options.commandFilesystem === undefined ? {} : { filesystem: options.commandFilesystem }),
    ...(options.command === undefined ? {} : { override: options.command }),
    ...(rowCommand.kind === "command" ? { rowCommand: rowCommand.command } : {}),
    port: portR.data,
    host: devLeaseLoopbackHost,
    project: `${options.user}/${options.name}`,
  })
  if (!commandR.success) return commandR
  const unitR = devUnitName({
    user: options.user,
    project: options.name,
    ...(options.serviceId === undefined ? {} : { serviceId: options.serviceId }),
  })
  if (!unitR.success) return unitR
  let userR: Awaited<ReturnType<DevLeaseUpUseCaseOptions["userResolve"]>>
  try {
    userR = await options.userResolve(options.user)
  } catch {
    return createResultError(op, "dev user resolution is unavailable")
  }
  if (!userR.success) return userR

  const lease: DevLeaseRecord = {
    projectKey: { owner: options.user, name: options.name },
    ...(options.serviceId === undefined ? {} : { serviceId: options.serviceId }),
    user: options.user,
    port: portR.data,
    unit: unitR.data,
    hostname: hostnameR.data,
    state: "starting",
    ttlMs,
    lastSeenAt: now,
    createdAt: now,
  }
  const startingR = await options.tracking.write({ version: 1, leases: [...base, lease] })
  if (!startingR.success) return startingR

  async function cleanup(): Promise<void> {
    await devUnitStop({ runner: options.runner, unit: lease.unit })
    await options.tracking.write({ version: 1, leases: base })
  }

  const startR = await devUnitStart({
    runner: options.runner,
    spec: {
      unit: lease.unit,
      user: options.user,
      uid: userR.data.uid,
      workingDirectory: directoryR.data.directory,
      port: lease.port,
      hostname: lease.hostname,
      pathValue,
      command: commandR.data.command,
      args: commandR.data.args,
    },
  })
  if (!startR.success) {
    await cleanup()
    return startR
  }
  const healthR = await healthWait({
    fetch,
    clock,
    wait,
    port: lease.port,
    timeoutMs: healthTimeoutMs,
    intervalMs: healthIntervalMs,
  })
  if (!healthR.success) {
    await cleanup()
    return healthR
  }
  const active: DevLeaseRecord = { ...lease, state: "active", lastSeenAt: clock() }
  const activeR = await options.tracking.write({ version: 1, leases: [...base, active] })
  if (!activeR.success) {
    await cleanup()
    return activeR
  }
  const regenerateR = await options.regenerate()
  if (!regenerateR.success) {
    await cleanup()
    return regenerateR
  }
  return createResult(active)
}
