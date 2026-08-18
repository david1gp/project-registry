import { createResult, createResultError, type PromiseResult } from "#result"

function secretIsValid(secret: string): boolean {
  return /^[A-Za-z0-9_-]{43,256}$/.test(secret)
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function zitadelPreAuthCookieHash(secret: string): PromiseResult<string> {
  const op = "zitadelPreAuthCookieHash"
  if (typeof secret !== "string" || !secretIsValid(secret)) return createResultError(op, "pre-auth cookie is invalid")
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
    return createResult(hexEncode(new Uint8Array(digest)))
  } catch {
    return createResultError(op, "pre-auth cookie could not be bound")
  }
}
