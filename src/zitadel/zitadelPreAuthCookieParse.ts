import { createResult, createResultError, type Result } from "#result"

const cookieName = "__Host-project-registry-pre-auth"
const maximumCookieHeaderLength = 8192
const maximumCookieValueLength = 256

export function zitadelPreAuthCookieParse(cookieHeader: string | null | undefined): Result<string> {
  const op = "zitadelPreAuthCookieParse"
  if (typeof cookieHeader !== "string" || cookieHeader.length > maximumCookieHeaderLength) {
    return createResultError(op, "pre-auth cookie is unavailable")
  }
  const prefix = `${cookieName}=`
  let found: string | undefined
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(prefix)) continue
    if (found !== undefined) return createResultError(op, "pre-auth cookie is invalid")
    found = trimmed.slice(prefix.length)
  }
  if (found === undefined || found.length === 0) return createResultError(op, "pre-auth cookie is unavailable")
  try {
    const secret = decodeURIComponent(found)
    if (secret.length > maximumCookieValueLength || !/^[A-Za-z0-9_-]{43,256}$/.test(secret)) {
      return createResultError(op, "pre-auth cookie is invalid")
    }
    return createResult(secret)
  } catch {
    return createResultError(op, "pre-auth cookie is invalid")
  }
}
