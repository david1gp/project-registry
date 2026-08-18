import { createResult, createResultError, type Result } from "#result"
import type { ZitadelOidcConfig } from "./ZitadelOidcConfig.js"

function urlIsExactOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0 &&
      url.search.length === 0 &&
      url.pathname === "/" &&
      url.origin === value
    )
  } catch {
    return false
  }
}

function callbackUrlIsValid(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0
  } catch {
    return false
  }
}

export function zitadelConfigValidate(config: unknown): Result<ZitadelOidcConfig> {
  const op = "zitadelConfigValidate"
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return createResultError(op, "Zitadel configuration is invalid")
  }
  const values = config as Record<string, unknown>
  const issuer = values.issuer
  const clientId = values.clientId
  const clientSecret = values.clientSecret
  const callbackUrl = values.callbackUrl
  const scope = values.scope
  const clockSkewSeconds = values.clockSkewSeconds
  const loginTransactionMaxAgeSeconds = values.loginTransactionMaxAgeSeconds
  const validClockSkewSeconds =
    clockSkewSeconds === undefined ? undefined : typeof clockSkewSeconds === "number" ? clockSkewSeconds : null
  const validLoginTransactionMaxAgeSeconds =
    loginTransactionMaxAgeSeconds === undefined
      ? undefined
      : typeof loginTransactionMaxAgeSeconds === "number"
        ? loginTransactionMaxAgeSeconds
        : null
  if (
    typeof issuer !== "string" ||
    issuer.length > 2048 ||
    !urlIsExactOrigin(issuer) ||
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    clientId.length > 256 ||
    (clientSecret !== undefined &&
      (typeof clientSecret !== "string" || clientSecret.length === 0 || clientSecret.length > 4096)) ||
    typeof callbackUrl !== "string" ||
    callbackUrl.length > 2048 ||
    !callbackUrlIsValid(callbackUrl)
  ) {
    return createResultError(op, "Zitadel configuration is invalid")
  }
  if (
    scope !== undefined &&
    (!Array.isArray(scope) ||
      scope.length === 0 ||
      scope.length > 32 ||
      scope.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128) ||
      !scope.includes("openid"))
  ) {
    return createResultError(op, "Zitadel configuration is invalid")
  }
  if (
    validClockSkewSeconds === null ||
    (validClockSkewSeconds !== undefined &&
      (!Number.isInteger(validClockSkewSeconds) || validClockSkewSeconds < 0 || validClockSkewSeconds > 3600))
  ) {
    return createResultError(op, "Zitadel configuration is invalid")
  }
  if (
    validLoginTransactionMaxAgeSeconds === null ||
    (validLoginTransactionMaxAgeSeconds !== undefined &&
      (!Number.isInteger(validLoginTransactionMaxAgeSeconds) ||
        validLoginTransactionMaxAgeSeconds < 1 ||
        validLoginTransactionMaxAgeSeconds > 900))
  ) {
    return createResultError(op, "Zitadel configuration is invalid")
  }
  return createResult({
    issuer,
    clientId,
    clientSecret,
    callbackUrl,
    scope: scope as readonly string[] | undefined,
    clockSkewSeconds: validClockSkewSeconds ?? undefined,
    loginTransactionMaxAgeSeconds: validLoginTransactionMaxAgeSeconds ?? undefined,
  })
}
