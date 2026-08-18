import { createResult, createResultError, type PromiseResult } from "#result"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { timeExpiryResolve } from "../runtime/timeExpiryResolve.js"
import type { ZitadelTokenExchangeOptions } from "./ZitadelTokenExchangeOptions.js"
import type { ZitadelTokens } from "./ZitadelTokens.js"
import { zitadelConfigValidate } from "./zitadelConfigValidate.js"
import { zitadelHttpJsonFetch } from "./zitadelHttpJsonFetch.js"

export async function zitadelTokenExchange(options: ZitadelTokenExchangeOptions): PromiseResult<ZitadelTokens> {
  const op = "zitadelTokenExchange"
  if (
    typeof options.code !== "string" ||
    options.code.length === 0 ||
    options.code.length > 4096 ||
    typeof options.codeVerifier !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(options.codeVerifier) ||
    typeof options.http !== "function"
  ) {
    return createResultError(op, "authorization code exchange failed")
  }
  const configR = zitadelConfigValidate(options.config)
  if (!configR.success || options.discovery.issuer !== configR.data.issuer) {
    return createResultError(op, "authorization code exchange failed")
  }
  const clock = options.clock ?? Date.now
  const nowR = clockNowResolve(clock)
  if (!nowR.success) return createResultError(op, "authorization code exchange failed")
  if (typeof options.discovery.tokenEndpoint !== "string" || options.discovery.tokenEndpoint.length > 2048) {
    return createResultError(op, "authorization code exchange failed")
  }
  try {
    const tokenEndpoint = new URL(options.discovery.tokenEndpoint)
    if (
      tokenEndpoint.protocol !== "https:" ||
      tokenEndpoint.username.length > 0 ||
      tokenEndpoint.password.length > 0 ||
      tokenEndpoint.hash.length > 0
    ) {
      return createResultError(op, "authorization code exchange failed")
    }
  } catch {
    return createResultError(op, "authorization code exchange failed")
  }
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: configR.data.clientId,
      code: options.code,
      redirect_uri: configR.data.callbackUrl,
      code_verifier: options.codeVerifier,
    })
    if (configR.data.clientSecret !== undefined) body.set("client_secret", configR.data.clientSecret)
    const responseR = await zitadelHttpJsonFetch(
      options.http,
      options.discovery.tokenEndpoint,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      { timeoutMs: options.timeoutMs, signal: options.signal, maxBodyBytes: options.maxBodyBytes },
    )
    if (!responseR.success || !responseR.data.response.ok)
      return createResultError(op, "authorization code exchange failed")
    const value: unknown = responseR.data.body
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return createResultError(op, "authorization code exchange failed")
    }
    const data = value as Record<string, unknown>
    if (
      typeof data.access_token !== "string" ||
      data.access_token.length === 0 ||
      data.access_token.length > 8192 ||
      typeof data.id_token !== "string" ||
      data.id_token.length === 0 ||
      data.id_token.length > 32_768
    ) {
      return createResultError(op, "authorization code exchange failed")
    }
    if (
      data.refresh_token !== undefined &&
      (typeof data.refresh_token !== "string" || data.refresh_token.length === 0 || data.refresh_token.length > 8192)
    ) {
      return createResultError(op, "authorization code exchange failed")
    }
    if (
      data.expires_in !== undefined &&
      (typeof data.expires_in !== "number" || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0)
    ) {
      return createResultError(op, "authorization code exchange failed")
    }
    const expiresAtR = data.expires_in === undefined ? undefined : timeExpiryResolve(nowR.data, data.expires_in)
    if (expiresAtR !== undefined && !expiresAtR.success) {
      return createResultError(op, "authorization code exchange failed")
    }
    return createResult({
      accessToken: data.access_token,
      refreshToken: data.refresh_token as string | undefined,
      idToken: data.id_token,
      expiresAt: expiresAtR?.data,
    })
  } catch {
    return createResultError(op, "authorization code exchange failed")
  }
}
