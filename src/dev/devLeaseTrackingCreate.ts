import { dirname } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevLeaseTrackingFilesystem } from "./DevLeaseTrackingFilesystem.js"
import { type DevLeaseTrackingState, devLeaseTrackingStateSchema } from "./devLeaseTrackingState.js"

const trackingDirectoryMode = 0o700
const trackingFileMode = 0o600

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function stateIsUnique(state: DevLeaseTrackingState): boolean {
  const hostnames = new Set<string>()
  const projectKeys = new Set<string>()
  const ports = new Set<number>()
  for (const lease of state.leases) {
    if (hostnames.has(lease.hostname)) return false
    hostnames.add(lease.hostname)
    const projectKeyValue = `${lease.projectKey.owner}\0${lease.projectKey.name}`
    if (projectKeys.has(projectKeyValue)) return false
    projectKeys.add(projectKeyValue)
    if (ports.has(lease.port)) return false
    ports.add(lease.port)
  }
  return true
}

function stateParse(value: unknown): Result<DevLeaseTrackingState> {
  const parsed = a.safeParse(devLeaseTrackingStateSchema, value)
  if (!parsed.success || !stateIsUnique(parsed.output)) {
    return createResultError("devLeaseTrackingRead", "Dev lease tracking state is corrupt")
  }
  return createResult(parsed.output)
}

export function devLeaseTrackingCreate(options: {
  path: string
  filesystem: DevLeaseTrackingFilesystem
}): Result<DevLeaseTracking> {
  const op = "devLeaseTrackingCreate"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Dev lease tracking options are required")
  if (typeof options.path !== "string" || options.path.length === 0) {
    return createResultError(op, "Dev lease tracking path is required")
  }
  if (typeof options.filesystem !== "object" || options.filesystem === null) {
    return createResultError(op, "Dev lease tracking filesystem is required")
  }
  const methods = ["readFile", "mkdir", "writeFile", "rename", "unlink"] as const
  if (methods.some((method) => typeof options.filesystem[method] !== "function")) {
    return createResultError(op, "Dev lease tracking filesystem is invalid")
  }

  const filesystem = options.filesystem
  let writeTail: Promise<void> = Promise.resolve()

  async function read(): PromiseResult<DevLeaseTrackingState> {
    let value: string
    try {
      value = await filesystem.readFile(options.path)
    } catch (error) {
      if (missingFile(error)) return createResult({ version: 1, leases: [] })
      return createResultError("devLeaseTrackingRead", "Dev lease tracking state could not be read")
    }
    let parsedValue: unknown
    try {
      parsedValue = JSON.parse(value)
    } catch {
      return createResultError("devLeaseTrackingRead", "Dev lease tracking state is corrupt")
    }
    return stateParse(parsedValue)
  }

  async function writeNow(state: DevLeaseTrackingState): Promise<void> {
    const temporaryPath = `${options.path}.tmp-${process.pid}`
    try {
      await filesystem.mkdir(dirname(options.path), trackingDirectoryMode)
      await filesystem.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, trackingFileMode)
      await filesystem.rename(temporaryPath, options.path)
    } catch (error) {
      try {
        await filesystem.unlink(temporaryPath)
      } catch {
        // Preserve the atomic write failure.
      }
      throw error
    }
  }

  function write(state: DevLeaseTrackingState): PromiseResult<void> {
    const parsed = stateParse(state)
    if (!parsed.success) return Promise.resolve(createResultError(op, "Dev lease tracking state is invalid"))
    const current = writeTail.then(
      () => writeNow(parsed.data),
      () => writeNow(parsed.data),
    )
    writeTail = current.then(
      () => undefined,
      () => undefined,
    )
    return current.then(
      () => createResult(undefined),
      () => createResultError("devLeaseTrackingWrite", "Dev lease tracking state could not be written"),
    )
  }

  return createResult({ read, write })
}
