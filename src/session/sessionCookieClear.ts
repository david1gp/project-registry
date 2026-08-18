import { createResult, createResultError, type Result } from "#result"
import type { SessionCookieOptions } from "./SessionCookieOptions.js"

const defaultCookieName = "__Host-project-registry-session"
const maximumCookieHeaderLength = 8192

function sessionCookieNameResolve(options: SessionCookieOptions): string | undefined {
  const name = options.name ?? defaultCookieName
  if (name.length > 128 || !/^__Host-[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return undefined
  return name
}

export function sessionCookieClear(options: SessionCookieOptions = {}): Result<string> {
  const op = "sessionCookieClear"
  const name = sessionCookieNameResolve(options)
  if (name === undefined) return createResultError(op, "session cookie name is invalid")
  const cookie = `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  if (cookie.length > maximumCookieHeaderLength) return createResultError(op, "session cookie is invalid")
  return createResult(cookie)
}
