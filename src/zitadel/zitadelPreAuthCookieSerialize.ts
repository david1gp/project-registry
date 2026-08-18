import { createResult, createResultError, type Result } from "#result"
import type { ZitadelPreAuthCookieOptions } from "./ZitadelPreAuthCookieOptions.js"

const cookieName = "__Host-project-registry-pre-auth"
const defaultMaxAgeSeconds = 600
const maximumCookieHeaderLength = 8192

export function zitadelPreAuthCookieSerialize(
  secret: string,
  options: ZitadelPreAuthCookieOptions = {},
): Result<string> {
  const op = "zitadelPreAuthCookieSerialize"
  const maxAgeSeconds = options.maxAgeSeconds ?? defaultMaxAgeSeconds
  if (
    typeof secret !== "string" ||
    !/^[A-Za-z0-9_-]{43,256}$/.test(secret) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > 31_536_000
  ) {
    return createResultError(op, "pre-auth cookie is invalid")
  }
  const cookie = `${cookieName}=${encodeURIComponent(secret)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`
  if (cookie.length > maximumCookieHeaderLength) return createResultError(op, "pre-auth cookie is invalid")
  return createResult(cookie)
}
