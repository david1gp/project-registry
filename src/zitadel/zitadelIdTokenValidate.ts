import { createResult, createResultError, type PromiseResult } from "#result"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { timeMillisecondsValidate } from "../runtime/timeMillisecondsValidate.js"
import { timeSecondsValidate } from "../runtime/timeSecondsValidate.js"
import type { Clock } from "../session/Clock.js"
import type { ZitadelIdentityClaims } from "./ZitadelIdentityClaims.js"
import type { ZitadelJwk } from "./ZitadelJwk.js"
import type { ZitadelJwks } from "./ZitadelJwks.js"
import type { ZitadelOidcConfig } from "./ZitadelOidcConfig.js"
import { zitadelConfigValidate } from "./zitadelConfigValidate.js"
import { zitadelJwksValidate } from "./zitadelJwksValidate.js"

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function base64UrlDecode(value: string, maximumLength: number): Uint8Array | undefined {
  if (value.length > maximumLength || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return base64UrlEncode(bytes) === value ? bytes : undefined
  } catch {
    return undefined
  }
}

function jsonDecode(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return undefined
  }
}

type ImportKeyAlgorithm = {
  name: string
  hash?: string
  namedCurve?: string
}

type WebCryptoVerifier = {
  importKey(
    format: string,
    keyData: unknown,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<unknown>
  verify(algorithm: unknown, key: unknown, signature: unknown, data: unknown): Promise<boolean>
}

function signatureAlgorithm(alg: string): ImportKeyAlgorithm | undefined {
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
  if (alg === "PS256") return { name: "RSA-PSS", hash: "SHA-256" }
  if (alg === "ES256") return { name: "ECDSA", namedCurve: "P-256" }
  return undefined
}

function keyMatchesAlgorithm(key: ZitadelJwk, alg: string): boolean {
  if (alg === "RS256" || alg === "PS256") return key.kty === "RSA" && (key.alg === undefined || key.alg === alg)
  if (alg === "ES256") return key.kty === "EC" && key.crv === "P-256" && (key.alg === undefined || key.alg === alg)
  return false
}

function keyIdIsValid(value: unknown): value is string {
  if (typeof value !== "string") return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return value.length > 0 && value.length <= 256 && !/\s/.test(value)
}

function claimStringIsValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

function audienceIsExact(audience: unknown, clientId: string): boolean {
  if (typeof audience === "string") return audience === clientId
  return Array.isArray(audience) && audience.length === 1 && audience[0] === clientId
}

function claimNumberIsValid(value: unknown): value is number {
  return timeSecondsValidate(value)
}

export async function zitadelIdTokenValidate(
  idToken: string,
  config: ZitadelOidcConfig,
  nonce: string,
  jwks: ZitadelJwks,
  clock: Clock = Date.now,
): PromiseResult<ZitadelIdentityClaims> {
  const op = "zitadelIdTokenValidate"
  if (
    typeof idToken !== "string" ||
    idToken.length === 0 ||
    idToken.length > 32_768 ||
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    nonce.length > 256
  ) {
    return createResultError(op, "identity token is invalid")
  }
  const configR = zitadelConfigValidate(config)
  if (!configR.success) return createResultError(op, "identity token is invalid")
  const validConfig = configR.data
  const jwksR = zitadelJwksValidate(jwks)
  if (!jwksR.success) return createResultError(op, "identity token is invalid")
  const parts = idToken.split(".")
  if (parts.length !== 3) return createResultError(op, "identity token is invalid")
  const headerBytes = base64UrlDecode(parts[0] ?? "", 4_096)
  const payloadBytes = base64UrlDecode(parts[1] ?? "", 16_384)
  const signature = base64UrlDecode(parts[2] ?? "", 4_096)
  if (headerBytes === undefined || payloadBytes === undefined || signature === undefined) {
    return createResultError(op, "identity token is invalid")
  }
  const header = jsonDecode(headerBytes)
  const claims = jsonDecode(payloadBytes)
  if (
    typeof header !== "object" ||
    header === null ||
    Array.isArray(header) ||
    typeof claims !== "object" ||
    claims === null ||
    Array.isArray(claims)
  ) {
    return createResultError(op, "identity token is invalid")
  }
  const headerValues = header as Record<string, unknown>
  const claimValues = claims as Record<string, unknown>
  const algorithm = headerValues.alg
  const keyId = headerValues.kid
  if (typeof algorithm !== "string" || algorithm.length > 16 || !keyIdIsValid(keyId)) {
    return createResultError(op, "identity token is invalid")
  }
  const verificationAlgorithm = signatureAlgorithm(algorithm)
  if (verificationAlgorithm === undefined) return createResultError(op, "identity token is invalid")
  const key = jwksR.data.keys.find((entry) => entry.kid === keyId && keyMatchesAlgorithm(entry, algorithm))
  if (key === undefined) return createResultError(op, "identity token is invalid")
  let signatureValid = false
  try {
    const verifier = crypto.subtle as unknown as WebCryptoVerifier
    const cryptoKey = await verifier.importKey("jwk", key, verificationAlgorithm, false, ["verify"])
    const verifyAlgorithm =
      algorithm === "PS256"
        ? { name: "RSA-PSS", saltLength: 32 }
        : algorithm === "ES256"
          ? { name: "ECDSA", hash: "SHA-256" }
          : verificationAlgorithm
    signatureValid = await verifier.verify(
      verifyAlgorithm,
      cryptoKey,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
  } catch {
    return createResultError(op, "identity token is invalid")
  }
  if (!signatureValid) return createResultError(op, "identity token is invalid")

  const nowR = clockNowResolve(clock)
  if (!nowR.success) return createResultError(op, "identity token claims are invalid")
  const nowSeconds = Math.floor(nowR.data / 1000)
  const skewSeconds = validConfig.clockSkewSeconds ?? 0
  const nowWithSkew = nowSeconds + skewSeconds
  const expiration = claimValues.exp
  const issuedAt = claimValues.iat
  const notBefore = claimValues.nbf
  const expirationWithSkew = typeof expiration === "number" ? expiration + skewSeconds : Number.NaN
  const expiresAt =
    typeof expiration === "number" && timeMillisecondsValidate(expiration * 1000) ? expiration * 1000 : undefined
  if (
    claimValues.iss !== validConfig.issuer ||
    !audienceIsExact(claimValues.aud, validConfig.clientId) ||
    !claimStringIsValid(claimValues.sub) ||
    claimValues.preferred_username === undefined ||
    !claimStringIsValid(claimValues.preferred_username) ||
    claimValues.nonce !== nonce ||
    !claimNumberIsValid(expiration) ||
    !claimNumberIsValid(issuedAt) ||
    !timeSecondsValidate(nowWithSkew) ||
    !timeSecondsValidate(expirationWithSkew) ||
    expiresAt === undefined ||
    nowSeconds >= expirationWithSkew ||
    issuedAt > nowWithSkew ||
    (claimValues.nbf !== undefined && (!claimNumberIsValid(notBefore) || nowWithSkew < notBefore)) ||
    (claimValues.azp !== undefined && claimValues.azp !== validConfig.clientId)
  ) {
    return createResultError(op, "identity token claims are invalid")
  }
  return createResult({
    subject: claimValues.sub,
    preferredUsername: claimValues.preferred_username,
    expiresAt,
  })
}
