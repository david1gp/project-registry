import { createResult, createResultError, type Result } from "#result"
import type { ZitadelDiscoveryDocument } from "./ZitadelDiscoveryDocument.js"

function endpointIsValid(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0
  } catch {
    return false
  }
}

function issuerIsValid(value: unknown): value is string {
  if (!endpointIsValid(value)) return false
  try {
    const url = new URL(value)
    return url.pathname === "/" && url.search.length === 0 && url.origin === value
  } catch {
    return false
  }
}

export function zitadelDiscoveryValidate(value: unknown): Result<ZitadelDiscoveryDocument> {
  const op = "zitadelDiscoveryValidate"
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createResultError(op, "Zitadel discovery is invalid")
  }
  const values = value as Record<string, unknown>
  if (
    !issuerIsValid(values.issuer) ||
    !endpointIsValid(values.authorizationEndpoint) ||
    !endpointIsValid(values.tokenEndpoint) ||
    !endpointIsValid(values.jwksUri)
  ) {
    return createResultError(op, "Zitadel discovery is invalid")
  }
  return createResult({
    issuer: values.issuer,
    authorizationEndpoint: values.authorizationEndpoint,
    tokenEndpoint: values.tokenEndpoint,
    jwksUri: values.jwksUri,
  })
}
