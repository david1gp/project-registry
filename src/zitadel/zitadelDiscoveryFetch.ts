import { createResult, createResultError, type PromiseResult } from "#result"
import type { ZitadelDiscoveryDocument } from "./ZitadelDiscoveryDocument.js"
import type { ZitadelHttp } from "./ZitadelHttp.js"
import type { ZitadelHttpOptions } from "./ZitadelHttpOptions.js"
import type { ZitadelOidcConfig } from "./ZitadelOidcConfig.js"
import { zitadelConfigValidate } from "./zitadelConfigValidate.js"
import { zitadelDiscoveryValidate } from "./zitadelDiscoveryValidate.js"
import { zitadelHttpJsonFetch } from "./zitadelHttpJsonFetch.js"

export async function zitadelDiscoveryFetch(
  config: ZitadelOidcConfig,
  http: ZitadelHttp,
  options: ZitadelHttpOptions = {},
): PromiseResult<ZitadelDiscoveryDocument> {
  const op = "zitadelDiscoveryFetch"
  if (typeof http !== "function") return createResultError(op, "Zitadel discovery is unavailable")
  const configR = zitadelConfigValidate(config)
  if (!configR.success) return createResultError(op, "Zitadel discovery is invalid")
  const validConfig = configR.data
  try {
    const issuer = new URL(validConfig.issuer)
    if (
      issuer.protocol !== "https:" ||
      issuer.username.length > 0 ||
      issuer.password.length > 0 ||
      issuer.hash.length > 0 ||
      issuer.search.length > 0 ||
      issuer.pathname !== "/" ||
      issuer.origin !== validConfig.issuer
    ) {
      return createResultError(op, "Zitadel discovery is invalid")
    }
  } catch {
    return createResultError(op, "Zitadel discovery is invalid")
  }
  const url = `${validConfig.issuer}/.well-known/openid-configuration`
  try {
    const responseR = await zitadelHttpJsonFetch(
      http,
      url,
      { method: "GET", headers: { accept: "application/json" } },
      options,
    )
    if (!responseR.success) return createResultError(op, "Zitadel discovery is unavailable")
    if (!responseR.data.response.ok) return createResultError(op, "Zitadel discovery is unavailable")
    const body: unknown = responseR.data.body
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return createResultError(op, "Zitadel discovery is invalid")
    }
    const values = body as Record<string, unknown>
    const discoveryR = zitadelDiscoveryValidate({
      issuer: values.issuer,
      authorizationEndpoint: values.authorization_endpoint,
      tokenEndpoint: values.token_endpoint,
      jwksUri: values.jwks_uri,
    })
    if (!discoveryR.success || discoveryR.data.issuer !== validConfig.issuer) {
      return createResultError(op, "Zitadel discovery is invalid")
    }
    return createResult(discoveryR.data)
  } catch {
    return createResultError(op, "Zitadel discovery is unavailable")
  }
}
