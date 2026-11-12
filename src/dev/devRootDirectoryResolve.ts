import { resolve } from "node:path"
import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import type { DevRoot } from "./DevRoot.js"
import { devProjectDirectoryResolve } from "./devProjectDirectoryResolve.js"

export type DevRootDirectory = {
  root: string
  directory: string
}

/**
 * Pick the dev root holding `<project>` for `user`. Only roots whose
 * allowlist names the user are searched; `rootPath` narrows to one root.
 * Missing everywhere → `dev.not-found`; present in several allowed roots →
 * `projects.conflict` asking for `--root`; an explicitly requested root the
 * user may not use → `dev.forbidden`. Escapes surface as `dev.forbidden`.
 */
export async function devRootDirectoryResolve(options: {
  roots: readonly DevRoot[]
  user: string
  project: string
  rootPath?: string
  filesystem?: DevProjectFilesystem
}): Promise<Result<DevRootDirectory>> {
  const op = "devRootDirectoryResolve"
  if (typeof options !== "object" || options === null || !Array.isArray(options.roots)) {
    return createResultError(op, "dev root options are required")
  }
  if (options.roots.length === 0) return createResultError(op, "dev project directory is unavailable")
  const allowed = options.roots.filter((root) => root.users === undefined || root.users.includes(options.user))
  let candidates = allowed
  if (options.rootPath !== undefined) {
    const requested = resolve(options.rootPath)
    const configured = options.roots.find((root) => root.path === requested)
    if (configured === undefined) {
      return createResultErrorCode(op, `dev root ${requested} is not configured`, "dev.not-found")
    }
    if (!allowed.includes(configured)) {
      return createResultErrorCode(op, `dev root ${requested} is not allowed for ${options.user}`, "dev.forbidden")
    }
    candidates = [configured]
  }
  if (candidates.length === 0) {
    return createResultErrorCode(op, `no dev root is allowed for ${options.user}`, "dev.forbidden")
  }
  const found: DevRootDirectory[] = []
  let firstFailure: Extract<Result<string>, { success: false }> | undefined
  for (const root of candidates) {
    const directoryR = await devProjectDirectoryResolve({
      projectsRoot: root.path,
      project: options.project,
      ...(options.filesystem === undefined ? {} : { filesystem: options.filesystem }),
    })
    if (directoryR.success) {
      found.push({ root: resolve(directoryR.data, ".."), directory: directoryR.data })
      continue
    }
    // A forbidden escape in any root wins over "missing elsewhere" so a
    // symlink trap is reported, never silently skipped.
    if (directoryR.code === "dev.forbidden" || directoryR.code === "request.invalid") return directoryR
    if (directoryR.code !== "dev.not-found") return directoryR
    firstFailure ??= directoryR
  }
  if (found.length === 1) return createResult(found[0]!)
  if (found.length > 1) {
    return createResultErrorCode(
      op,
      `dev project ${options.project} exists in several roots (${found.map((entry) => entry.root).join(", ")}); pass --root <path>`,
      "projects.conflict",
    )
  }
  return firstFailure ?? createResultErrorCode(op, "dev project directory is missing", "dev.not-found")
}
