import { dirname } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { ProjectRegistryDaemonPrivateDnsTracking } from "./ProjectRegistryDaemonPrivateDnsTracking.js"
import type { ProjectRegistryDaemonPrivateDnsTrackingFilesystem } from "./ProjectRegistryDaemonPrivateDnsTrackingFilesystem.js"
import { projectRegistryDaemonPrivateDnsTrackingStateSchema } from "./ProjectRegistryDaemonPrivateDnsTrackingState.js"

const trackingDirectoryMode = 0o700
const trackingFileMode = 0o600

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function stateIsUnique(state: a.InferOutput<typeof projectRegistryDaemonPrivateDnsTrackingStateSchema>): boolean {
  const hostnames = new Set<string>()
  for (const host of state.hosts) {
    if (hostnames.has(host.hostname)) return false
    hostnames.add(host.hostname)
    const projectKeys = new Set<string>()
    for (const projectKey of host.projectKeys) {
      const projectKeyValue = `${projectKey.owner}\u0000${projectKey.name}`
      if (projectKeys.has(projectKeyValue)) return false
      projectKeys.add(projectKeyValue)
    }
  }
  return true
}

function stateParse(value: unknown): Result<a.InferOutput<typeof projectRegistryDaemonPrivateDnsTrackingStateSchema>> {
  const parsed = a.safeParse(projectRegistryDaemonPrivateDnsTrackingStateSchema, value)
  if (!parsed.success || !stateIsUnique(parsed.output)) {
    return createResultError("projectRegistryDaemonPrivateDnsTrackingRead", "Private DNS tracking state is corrupt")
  }
  return createResult(parsed.output)
}

export function projectRegistryDaemonPrivateDnsTrackingCreate(options: {
  path: string
  filesystem: ProjectRegistryDaemonPrivateDnsTrackingFilesystem
}): Result<ProjectRegistryDaemonPrivateDnsTracking> {
  const op = "projectRegistryDaemonPrivateDnsTrackingCreate"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Private DNS tracking options are required")
  if (typeof options.path !== "string" || options.path.length === 0) {
    return createResultError(op, "Private DNS tracking path is required")
  }
  if (typeof options.filesystem !== "object" || options.filesystem === null) {
    return createResultError(op, "Private DNS tracking filesystem is required")
  }
  const methods = ["readFile", "mkdir", "writeFile", "rename", "unlink"] as const
  if (methods.some((method) => typeof options.filesystem[method] !== "function")) {
    return createResultError(op, "Private DNS tracking filesystem is invalid")
  }

  const filesystem = options.filesystem
  let writeTail: Promise<void> = Promise.resolve()

  async function read(): PromiseResult<a.InferOutput<typeof projectRegistryDaemonPrivateDnsTrackingStateSchema>> {
    let value: string
    try {
      value = await filesystem.readFile(options.path)
    } catch (error) {
      if (missingFile(error)) return createResult({ version: 1, hosts: [] })
      return createResultError(
        "projectRegistryDaemonPrivateDnsTrackingRead",
        "Private DNS tracking state could not be read",
      )
    }
    let parsedValue: unknown
    try {
      parsedValue = JSON.parse(value)
    } catch {
      return createResultError("projectRegistryDaemonPrivateDnsTrackingRead", "Private DNS tracking state is corrupt")
    }
    return stateParse(parsedValue)
  }

  async function writeNow(
    state: a.InferOutput<typeof projectRegistryDaemonPrivateDnsTrackingStateSchema>,
  ): Promise<void> {
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

  function write(state: a.InferOutput<typeof projectRegistryDaemonPrivateDnsTrackingStateSchema>): PromiseResult<void> {
    const parsed = stateParse(state)
    if (!parsed.success) return Promise.resolve(createResultError(op, "Private DNS tracking state is invalid"))
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
      () =>
        createResultError(
          "projectRegistryDaemonPrivateDnsTrackingWrite",
          "Private DNS tracking state could not be written",
        ),
    )
  }

  return createResult({ read, write })
}
