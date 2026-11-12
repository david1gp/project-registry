import { isAbsolute, relative, resolve } from "node:path"
import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import { devProjectFilesystemDefault } from "./devProjectFilesystemDefault.js"

const unitProjectPattern = /^[a-z0-9][a-z0-9-]*$/

function underRoot(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate)
  return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))
}

/**
 * Resolve `<root>/<project>` to its real directory. The project name is one
 * path segment by construction; the real path must stay a direct child of the
 * real root (symlinks out of the root, or into a nested directory, fail as
 * `dev.forbidden`). A missing entry or non-directory is `dev.not-found`.
 */
export async function devProjectDirectoryResolve(options: {
  projectsRoot?: string
  project: string
  filesystem?: DevProjectFilesystem
}): Promise<Result<string>> {
  const op = "devProjectDirectoryResolve"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "dev project directory options are required")
  }
  if (typeof options.projectsRoot !== "string" || options.projectsRoot.trim() === "") {
    return createResultError(op, "dev project directory is unavailable")
  }
  if (typeof options.project !== "string" || !unitProjectPattern.test(options.project)) {
    return createResultErrorCode(op, "dev project name is invalid", "request.invalid")
  }
  const filesystem = options.filesystem ?? devProjectFilesystemDefault()
  let root: string
  try {
    root = await filesystem.realpath(resolve(options.projectsRoot))
  } catch {
    return createResultErrorCode(op, "dev projects root is missing", "dev.not-found")
  }
  const candidate = resolve(root, options.project)
  if (!underRoot(root, candidate)) {
    return createResultErrorCode(op, "dev project directory escapes its projects root", "dev.forbidden")
  }
  let actual: string
  try {
    actual = await filesystem.realpath(candidate)
  } catch {
    return createResultErrorCode(op, "dev project directory is missing", "dev.not-found")
  }
  if (!underRoot(root, actual) || actual === root || resolve(actual, "..") !== root) {
    return createResultErrorCode(op, "dev project directory escapes its projects root", "dev.forbidden")
  }
  try {
    const status = await filesystem.stat(actual)
    if (!status.isDirectory())
      return createResultErrorCode(op, "dev project directory is not a directory", "dev.not-found")
  } catch {
    return createResultErrorCode(op, "dev project directory is missing", "dev.not-found")
  }
  return createResult(actual)
}
