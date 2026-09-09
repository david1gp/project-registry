import { dirname } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { ProjectRegistryDaemonCloudflareDnsTracking } from "./ProjectRegistryDaemonCloudflareDnsTracking.js"
import type { ProjectRegistryDaemonCloudflareDnsTrackingFilesystem } from "./ProjectRegistryDaemonCloudflareDnsTrackingFilesystem.js"
import { projectRegistryDaemonCloudflareDnsTrackingStateSchema } from "./ProjectRegistryDaemonCloudflareDnsTrackingState.js"

const trackingDirectoryMode = 0o700
const trackingFileMode = 0o600

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function stateIsUnique(state: a.InferOutput<typeof projectRegistryDaemonCloudflareDnsTrackingStateSchema>): boolean {
  const recordIds = new Set<string>()
  for (const record of state.records) {
    const recordKey = `${record.zoneId}\u0000${record.id}`
    if (recordIds.has(recordKey)) return false
    recordIds.add(recordKey)
    const projectKeys = new Set<string>()
    for (const projectKey of record.projectKeys) {
      const projectKeyValue = `${projectKey.owner}\u0000${projectKey.name}`
      if (projectKeys.has(projectKeyValue)) return false
      projectKeys.add(projectKeyValue)
    }
  }
  return true
}

function stateParse(
  value: unknown,
): Result<a.InferOutput<typeof projectRegistryDaemonCloudflareDnsTrackingStateSchema>> {
  const parsed = a.safeParse(projectRegistryDaemonCloudflareDnsTrackingStateSchema, value)
  if (!parsed.success || !stateIsUnique(parsed.output)) {
    return createResultError(
      "projectRegistryDaemonCloudflareDnsTrackingRead",
      "Cloudflare DNS tracking state is corrupt",
    )
  }
  return createResult(parsed.output)
}

export function projectRegistryDaemonCloudflareDnsTrackingCreate(options: {
  path: string
  filesystem: ProjectRegistryDaemonCloudflareDnsTrackingFilesystem
}): Result<ProjectRegistryDaemonCloudflareDnsTracking> {
  const op = "projectRegistryDaemonCloudflareDnsTrackingCreate"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Cloudflare DNS tracking options are required")
  if (typeof options.path !== "string" || options.path.length === 0) {
    return createResultError(op, "Cloudflare DNS tracking path is required")
  }
  if (typeof options.filesystem !== "object" || options.filesystem === null) {
    return createResultError(op, "Cloudflare DNS tracking filesystem is required")
  }
  const methods = ["readFile", "mkdir", "writeFile", "rename", "unlink"] as const
  if (methods.some((method) => typeof options.filesystem[method] !== "function")) {
    return createResultError(op, "Cloudflare DNS tracking filesystem is invalid")
  }

  const filesystem = options.filesystem
  let writeTail: Promise<void> = Promise.resolve()

  async function read(): PromiseResult<a.InferOutput<typeof projectRegistryDaemonCloudflareDnsTrackingStateSchema>> {
    let value: string
    try {
      value = await filesystem.readFile(options.path)
    } catch (error) {
      if (missingFile(error)) return createResult({ version: 1, records: [] })
      return createResultError(
        "projectRegistryDaemonCloudflareDnsTrackingRead",
        "Cloudflare DNS tracking state could not be read",
      )
    }
    let parsedValue: unknown
    try {
      parsedValue = JSON.parse(value)
    } catch {
      return createResultError(
        "projectRegistryDaemonCloudflareDnsTrackingRead",
        "Cloudflare DNS tracking state is corrupt",
      )
    }
    return stateParse(parsedValue)
  }

  async function writeNow(
    state: a.InferOutput<typeof projectRegistryDaemonCloudflareDnsTrackingStateSchema>,
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

  function write(
    state: a.InferOutput<typeof projectRegistryDaemonCloudflareDnsTrackingStateSchema>,
  ): PromiseResult<void> {
    const parsed = stateParse(state)
    if (!parsed.success) return Promise.resolve(createResultError(op, "Cloudflare DNS tracking state is invalid"))
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
          "projectRegistryDaemonCloudflareDnsTrackingWrite",
          "Cloudflare DNS tracking state could not be written",
        ),
    )
  }

  return createResult({ read, write })
}
