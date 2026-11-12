import { isAbsolute, resolve } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import type { DevRoot } from "./DevRoot.js"

const devRootUserPattern = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/

/**
 * Parse `PROJECT_REGISTRY_DEV_ROOTS`: `;`-separated `<absolute path>:<user,...>`
 * entries, e.g. `/projects:leo,david,tim,mit`. `*` as the user list allows
 * every caller. Duplicate roots and blank user lists fail closed.
 */
export function devRootsParse(value: string): Result<DevRoot[]> {
  const op = "devRootsParse"
  const roots: DevRoot[] = []
  const seen = new Set<string>()
  for (const rawEntry of value.split(";")) {
    const entry = rawEntry.trim()
    if (entry === "") continue
    const separator = entry.indexOf(":")
    if (separator === -1) return createResultError(op, `dev root "${entry}" needs <path>:<user,...>`)
    const path = entry.slice(0, separator).trim()
    if (!isAbsolute(path) || path.includes("\0")) {
      return createResultError(op, `dev root path "${path}" must be absolute`)
    }
    const normalized = resolve(path)
    if (seen.has(normalized)) return createResultError(op, `dev root "${normalized}" is listed twice`)
    seen.add(normalized)
    const users = entry
      .slice(separator + 1)
      .split(",")
      .map((user) => user.trim())
      .filter(Boolean)
    if (users.length === 0) return createResultError(op, `dev root "${normalized}" has no users`)
    if (users.includes("*")) {
      if (users.length !== 1) return createResultError(op, `dev root "${normalized}" mixes * with users`)
      roots.push({ path: normalized })
      continue
    }
    const invalid = users.find((user) => !devRootUserPattern.test(user))
    if (invalid !== undefined) return createResultError(op, `dev root "${normalized}" user "${invalid}" is invalid`)
    roots.push({ path: normalized, users: [...new Set(users)] })
  }
  if (roots.length === 0) return createResultError(op, "dev roots must list at least one root")
  return createResult(roots)
}
