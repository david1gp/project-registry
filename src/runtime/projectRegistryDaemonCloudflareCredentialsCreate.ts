import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { createResult, createResultError, createResultErrorCode, type PromiseResult, type Result } from "#result"
import type { ProjectRegistryDaemonCloudflareCredentials } from "./ProjectRegistryDaemonCloudflareCredentials.js"
import type { ProjectRegistryDaemonCloudflareCredentialsFilesystem } from "./ProjectRegistryDaemonCloudflareCredentialsFilesystem.js"

const preferredTokenName = "CLOUDFLARE_API_TOKEN"
const aliasTokenName = "CF_API_TOKEN"
const credentialsDirectoryMode = 0o700
const credentialsFileMode = 0o600
const maximumTokenLength = 8_192

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
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
  return `${owner}.env`
}

function tokenIsValid(token: unknown): token is string {
  if (typeof token !== "string" || token.length === 0 || token.length > maximumTokenLength) return false
  if (token.trim() !== token) return false
  return [...token].every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f
  })
}

function assignmentParse(line: string): { name: string; value: string } | undefined {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
  if (match === null) return undefined
  const name = match[1]!
  const rawValue = match[2]!.trim()
  if (rawValue.length === 0) return { name, value: "" }
  const quote = rawValue[0]
  if (quote === '"' || quote === "'") {
    if (rawValue.length < 2 || rawValue.at(-1) !== quote) return undefined
    return { name, value: rawValue.slice(1, -1) }
  }
  return { name, value: rawValue }
}

function tokenParse(value: string): string | undefined {
  let preferred: string | undefined
  let alias: string | undefined
  for (const line of value.split(/\r?\n/)) {
    const assignment = assignmentParse(line)
    if (assignment === undefined) continue
    const token = assignment.value.trim()
    if (assignment.name === preferredTokenName && token !== "") preferred = token
    if (assignment.name === aliasTokenName && token !== "") alias = token
  }
  return preferred ?? alias
}

/**
 * Create a hot-reloading resolver and privileged setter for root-managed per-owner Cloudflare credential files.
 * The setter writes only through the supplied filesystem boundary and must be called after owner authentication.
 */
export function projectRegistryDaemonCloudflareCredentialsCreate(options: {
  directory: string
  filesystem: ProjectRegistryDaemonCloudflareCredentialsFilesystem
}): Result<ProjectRegistryDaemonCloudflareCredentials> {
  const op = "projectRegistryDaemonCloudflareCredentialsCreate"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Cloudflare credentials options are required")
  }
  if (
    typeof options.directory !== "string" ||
    options.directory.length === 0 ||
    !options.directory.startsWith("/") ||
    options.directory.includes("\0")
  ) {
    return createResultError(op, "Cloudflare credentials directory is invalid")
  }
  if (typeof options.filesystem !== "object" || options.filesystem === null) {
    return createResultError(op, "Cloudflare credentials filesystem is required")
  }
  if (
    typeof options.filesystem.lstat !== "function" ||
    typeof options.filesystem.realpath !== "function" ||
    typeof options.filesystem.readFile !== "function"
  ) {
    return createResultError(op, "Cloudflare credentials filesystem is invalid")
  }

  const filesystem = options.filesystem
  const directory = resolve(options.directory)
  let writeSequence = 0
  let writeTail: Promise<void> = Promise.resolve()

  async function tokenResolve(owner: string): PromiseResult<string | undefined> {
    const filename = ownerFileName(owner)
    if (filename === undefined) return createResult(undefined)
    const path = join(directory, filename)
    let value: string
    try {
      const directoryStat = await filesystem.lstat(directory)
      if (directoryStat === undefined) return createResult(undefined)
      if (directoryStat.type !== "directory") return createResult(undefined)
      if ((await filesystem.realpath(directory)) !== directory) return createResult(undefined)

      const ownerFileStat = await filesystem.lstat(path)
      if (ownerFileStat === undefined) return createResult(undefined)
      if (ownerFileStat.type !== "file") return createResult(undefined)
      if ((await filesystem.realpath(path)) !== path) return createResult(undefined)

      value = await filesystem.readFile(path)
    } catch (error) {
      if (missingFile(error)) return createResult(undefined)
      return createResultError(
        "projectRegistryDaemonCloudflareCredentialsResolve",
        "Cloudflare credentials could not be read",
      )
    }
    return createResult(tokenParse(value))
  }

  async function tokenWriteNow(owner: string, token: string): Promise<void> {
    const filename = ownerFileName(owner)
    if (filename === undefined) throw new Error("invalid owner")
    if (
      typeof filesystem.lstat !== "function" ||
      typeof filesystem.realpath !== "function" ||
      typeof filesystem.mkdir !== "function" ||
      typeof filesystem.chmod !== "function" ||
      typeof filesystem.writeFile !== "function" ||
      typeof filesystem.rename !== "function" ||
      typeof filesystem.unlink !== "function"
    ) {
      throw new Error("Cloudflare credentials filesystem is not writable")
    }

    const path = join(directory, filename)
    writeSequence += 1
    const temporaryPath = `${path}.tmp-${process.pid}-${writeSequence}-${randomUUID()}`
    try {
      let directoryStat = await filesystem.lstat(directory)
      if (directoryStat === undefined) {
        await filesystem.mkdir(directory, credentialsDirectoryMode)
        directoryStat = await filesystem.lstat(directory)
      }
      if (directoryStat === undefined || directoryStat.type === "symlink" || directoryStat.type !== "directory") {
        throw new Error("Cloudflare credentials directory is unsafe")
      }
      if ((await filesystem.realpath(directory)) !== directory) {
        throw new Error("Cloudflare credentials directory is not canonical")
      }
      await filesystem.chmod(directory, credentialsDirectoryMode)
      await filesystem.writeFile(temporaryPath, `${preferredTokenName}=${token}\n`, credentialsFileMode)
      await filesystem.chmod(temporaryPath, credentialsFileMode)
      await filesystem.rename(temporaryPath, path)
    } catch (error) {
      try {
        await filesystem.unlink(temporaryPath)
      } catch {
        // Preserve the generic credential write failure.
      }
      throw error
    }
  }

  function tokenSet(owner: string, token: string): PromiseResult<{ updated: true }> {
    const tokenOp = "projectRegistryDaemonCloudflareCredentialsTokenSet"
    if (ownerFileName(owner) === undefined) {
      return Promise.resolve(
        createResultErrorCode(tokenOp, "Cloudflare credential owner is invalid", "request.invalid"),
      )
    }
    if (!tokenIsValid(token)) {
      return Promise.resolve(createResultErrorCode(tokenOp, "Cloudflare API token is invalid", "request.invalid"))
    }

    const current = writeTail.then(
      () => tokenWriteNow(owner, token),
      () => tokenWriteNow(owner, token),
    )
    writeTail = current.then(
      () => undefined,
      () => undefined,
    )
    return current.then(
      () => createResult({ updated: true as const }),
      () => createResultError(tokenOp, "Cloudflare credentials could not be written"),
    )
  }

  return createResult({ tokenResolve, tokenSet })
}
