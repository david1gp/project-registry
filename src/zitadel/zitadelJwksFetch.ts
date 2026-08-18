import { createResult, createResultError, type PromiseResult } from "#result"
import type { ZitadelHttp } from "./ZitadelHttp.js"
import type { ZitadelHttpOptions } from "./ZitadelHttpOptions.js"
import type { ZitadelJwks } from "./ZitadelJwks.js"
import { zitadelHttpJsonFetch } from "./zitadelHttpJsonFetch.js"
import { zitadelJwksValidate } from "./zitadelJwksValidate.js"

export async function zitadelJwksFetch(
  jwksUri: string,
  http: ZitadelHttp,
  options: ZitadelHttpOptions = {},
): PromiseResult<ZitadelJwks> {
  const op = "zitadelJwksFetch"
  if (typeof jwksUri !== "string" || jwksUri.length === 0 || jwksUri.length > 2048 || typeof http !== "function")
    return createResultError(op, "Zitadel keys are unavailable")
  try {
    const url = new URL(jwksUri)
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
      return createResultError(op, "Zitadel keys are unavailable")
    }
  } catch {
    return createResultError(op, "Zitadel keys are unavailable")
  }
  try {
    const responseR = await zitadelHttpJsonFetch(
      http,
      jwksUri,
      { method: "GET", headers: { accept: "application/json" } },
      options,
    )
    if (!responseR.success) return createResultError(op, "Zitadel keys are unavailable")
    if (!responseR.data.response.ok) return createResultError(op, "Zitadel keys are unavailable")
    const body: unknown = responseR.data.body
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return createResultError(op, "Zitadel keys are invalid")
    }
    const keysR = zitadelJwksValidate(body)
    if (!keysR.success) return createResultError(op, "Zitadel keys are invalid")
    return createResult(keysR.data)
  } catch {
    return createResultError(op, "Zitadel keys are unavailable")
  }
}
