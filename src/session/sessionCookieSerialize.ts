import { createResult, createResultError, type Result } from "#result"
import type { SessionCookieOptions } from "./SessionCookieOptions.js"

const defaultCookieName = "__Host-project-registry-session"
const defaultMaxAgeSeconds = 3600
const maximumCookieHeaderLength = 8192

function sessionCookieNameResolve(options: SessionCookieOptions): string | undefined {
  const name = options.name ?? defaultCookieName
  if (name.length > 128 || !/^__Host-[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return undefined
  return name
}

export function sessionCookieSerialize(sessionId: string, options: SessionCookieOptions = {}): Result<string> {
  const op = "sessionCookieSerialize"
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(sessionId)) {
    return createResultError(op, "session cookie value is invalid")
  }
  const name = sessionCookieNameResolve(options)
  const maxAgeSeconds = options.maxAgeSeconds ?? defaultMaxAgeSeconds
  if (name === undefined) return createResultError(op, "session cookie name is invalid")
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 31_536_000) {
    return createResultError(op, "session cookie lifetime is invalid")
  }
  const cookie = `${name}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`
  if (cookie.length > maximumCookieHeaderLength) return createResultError(op, "session cookie value is invalid")
  return createResult(cookie)
}
