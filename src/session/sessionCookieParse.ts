import { createResult, createResultError, type Result } from "#result"
import type { SessionCookieOptions } from "./SessionCookieOptions.js"

const defaultCookieName = "__Host-project-registry-session"
const maximumCookieHeaderLength = 8192
const maximumCookieValueLength = 256

function sessionCookieNameResolve(options: SessionCookieOptions): string | undefined {
  const name = options.name ?? defaultCookieName
  if (name.length > 128 || !/^__Host-[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return undefined
  return name
}

export function sessionCookieParse(
  cookieHeader: string | null | undefined,
  options: SessionCookieOptions = {},
): Result<string> {
  const op = "sessionCookieParse"
  if (typeof cookieHeader !== "string" || cookieHeader.length > maximumCookieHeaderLength) {
    return createResultError(op, "session cookie is unavailable")
  }
  const name = sessionCookieNameResolve(options)
  if (name === undefined) return createResultError(op, "session cookie name is invalid")
  const prefix = `${name}=`
  let found: string | undefined
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(prefix)) continue
    if (found !== undefined) return createResultError(op, "session cookie is invalid")
    found = trimmed.slice(prefix.length)
  }
  if (found === undefined || found.length === 0 || found.length > maximumCookieValueLength) {
    return createResultError(op, "session cookie is unavailable")
  }
  try {
    const value = decodeURIComponent(found)
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) return createResultError(op, "session cookie is invalid")
    return createResult(value)
  } catch {
    return createResultError(op, "session cookie is invalid")
  }
}
