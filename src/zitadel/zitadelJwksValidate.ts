import { createResult, createResultError, type Result } from "#result"
import type { ZitadelJwk } from "./ZitadelJwk.js"
import type { ZitadelJwks } from "./ZitadelJwks.js"

function base64UrlIsCanonical(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    return false
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    let encoded = ""
    for (const character of binary) encoded += String.fromCharCode(character.charCodeAt(0))
    const bytes = Uint8Array.from(encoded, (character) => character.charCodeAt(0))
    let reencodedBinary = ""
    for (const byte of bytes) reencodedBinary += String.fromCharCode(byte)
    const reencoded = btoa(reencodedBinary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    return reencoded === value
  } catch {
    return false
  }
}

function keyIdIsValid(value: unknown): value is string {
  if (typeof value !== "string") return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return value.length > 0 && value.length <= 256 && !/\s/.test(value)
}

function keyIsValid(value: unknown): value is ZitadelJwk {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const key = value as Record<string, unknown>
  if (typeof key.kty !== "string" || key.kty.length === 0 || key.kty.length > 32 || !keyIdIsValid(key.kid)) return false
  if (key.use !== undefined && key.use !== "sig") return false
  if (key.alg !== undefined && key.alg !== "RS256" && key.alg !== "PS256" && key.alg !== "ES256") return false
  if (key.kty === "RSA") {
    return (
      (key.alg === undefined || key.alg === "RS256" || key.alg === "PS256") &&
      base64UrlIsCanonical(key.n) &&
      base64UrlIsCanonical(key.e)
    )
  }
  if (key.kty === "EC") {
    return (
      (key.alg === undefined || key.alg === "ES256") &&
      key.crv === "P-256" &&
      base64UrlIsCanonical(key.x) &&
      base64UrlIsCanonical(key.y)
    )
  }
  return false
}

export function zitadelJwksValidate(value: unknown): Result<ZitadelJwks> {
  const op = "zitadelJwksValidate"
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createResultError(op, "Zitadel keys are invalid")
  }
  const keys = (value as Record<string, unknown>).keys
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 32 || !keys.every(keyIsValid)) {
    return createResultError(op, "Zitadel keys are invalid")
  }
  const keyIds = new Set(keys.map((key) => key.kid))
  if (keyIds.size !== keys.length) return createResultError(op, "Zitadel keys are invalid")
  return createResult({ keys })
}
