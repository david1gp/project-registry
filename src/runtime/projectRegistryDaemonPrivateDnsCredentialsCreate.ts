import { join, resolve } from "node:path"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { ProjectRegistryDaemonCloudflareCredentialsFilesystem } from "./ProjectRegistryDaemonCloudflareCredentialsFilesystem.js"

const preferredTokenName = "TAILSCALE_API_KEY"
const aliasTokenName = "TAILSCALE_ACCESS_TOKEN"
const credentialsFileName = "tailscale.env"

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
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
 * Create a hot-reloading resolver for the root-managed tailnet-wide Tailscale
 * API credential (`tailscale.env` in the private-DNS credentials directory).
 * Unlike Cloudflare credentials, the Tailscale token is tailnet-wide rather
 * than per-owner: one writer (the daemon) holds it. The token value is
 * returned, never logged or printed.
 */
export function projectRegistryDaemonPrivateDnsCredentialsCreate(options: {
  directory: string
  filesystem: ProjectRegistryDaemonCloudflareCredentialsFilesystem
}): Result<{ tokenResolve(): PromiseResult<string | undefined> }> {
  const op = "projectRegistryDaemonPrivateDnsCredentialsCreate"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Private DNS credentials options are required")
  }
  if (
    typeof options.directory !== "string" ||
    options.directory.length === 0 ||
    !options.directory.startsWith("/") ||
    options.directory.includes("\0")
  ) {
    return createResultError(op, "Private DNS credentials directory is invalid")
  }
  if (typeof options.filesystem !== "object" || options.filesystem === null) {
    return createResultError(op, "Private DNS credentials filesystem is required")
  }
  if (
    typeof options.filesystem.lstat !== "function" ||
    typeof options.filesystem.realpath !== "function" ||
    typeof options.filesystem.readFile !== "function"
  ) {
    return createResultError(op, "Private DNS credentials filesystem is invalid")
  }

  const filesystem = options.filesystem
  const directory = resolve(options.directory)

  async function tokenResolve(): PromiseResult<string | undefined> {
    const path = join(directory, credentialsFileName)
    let value: string
    try {
      const directoryStat = await filesystem.lstat(directory)
      if (directoryStat === undefined) return createResult(undefined)
      if (directoryStat.type !== "directory") return createResult(undefined)
      if ((await filesystem.realpath(directory)) !== directory) return createResult(undefined)

      const fileStat = await filesystem.lstat(path)
      if (fileStat === undefined) return createResult(undefined)
      if (fileStat.type !== "file") return createResult(undefined)
      if ((await filesystem.realpath(path)) !== path) return createResult(undefined)

      value = await filesystem.readFile(path)
    } catch (error) {
      if (missingFile(error)) return createResult(undefined)
      return createResultError(
        "projectRegistryDaemonPrivateDnsCredentialsResolve",
        "Private DNS credentials could not be read",
      )
    }
    return createResult(tokenParse(value))
  }

  return createResult({ tokenResolve })
}
