import { createResult, createResultError, type PromiseResult } from "#result"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import { randomBytesResultResolve } from "../runtime/randomBytesResultResolve.js"
import { timeExpiryResolve } from "../runtime/timeExpiryResolve.js"
import type { Clock } from "../session/Clock.js"
import type { RandomBytes } from "../session/RandomBytes.js"
import { randomBytesGenerate } from "../session/randomBytesGenerate.js"
import type { ZitadelLoginStartOptions } from "./ZitadelLoginStartOptions.js"
import type { ZitadelLoginStartResult } from "./ZitadelLoginStartResult.js"
import { zitadelConfigValidate } from "./zitadelConfigValidate.js"
import { zitadelDiscoveryFetch } from "./zitadelDiscoveryFetch.js"
import { zitadelPreAuthCookieHash } from "./zitadelPreAuthCookieHash.js"
import { zitadelPreAuthCookieSerialize } from "./zitadelPreAuthCookieSerialize.js"

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

async function pkceChallenge(codeVerifier: string): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))
    return base64UrlEncode(new Uint8Array(digest))
  } catch {
    return undefined
  }
}

async function randomValue(randomBytes: RandomBytes): Promise<string | undefined> {
  try {
    const bytesR = randomBytesResultResolve(randomBytes, 32)
    if (!bytesR.success) return undefined
    const value = base64UrlEncode(bytesR.data)
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

export async function zitadelLoginStart(options: ZitadelLoginStartOptions): PromiseResult<ZitadelLoginStartResult> {
  const op = "zitadelLoginStart"
  const configR = zitadelConfigValidate(options.config)
  if (!configR.success) return createResultError(op, "login configuration is invalid")
  const clock: Clock = options.clock ?? Date.now
  const randomBytes: RandomBytes = options.randomBytes ?? randomBytesGenerate
  const nowR = clockNowResolve(clock)
  if (!nowR.success) return createResultError(op, "login transaction could not be created")
  const maxAgeSeconds = configR.data.loginTransactionMaxAgeSeconds ?? 600
  const expiresAtR = timeExpiryResolve(nowR.data, maxAgeSeconds)
  if (!expiresAtR.success) return createResultError(op, "login transaction could not be created")
  try {
    const discoveryR = await zitadelDiscoveryFetch(configR.data, options.http, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxBodyBytes: options.maxBodyBytes,
    })
    if (!discoveryR.success) return createResultError(op, "login provider is unavailable")
    const state = await randomValue(randomBytes)
    const nonce = await randomValue(randomBytes)
    const codeVerifier = await randomValue(randomBytes)
    const preAuthCookieSecret = await randomValue(randomBytes)
    if (state === undefined || nonce === undefined || codeVerifier === undefined || preAuthCookieSecret === undefined) {
      return createResultError(op, "login transaction could not be created")
    }
    const preAuthCookieHashR = await zitadelPreAuthCookieHash(preAuthCookieSecret)
    if (!preAuthCookieHashR.success) return createResultError(op, "login transaction could not be created")
    const challenge = await pkceChallenge(codeVerifier)
    if (challenge === undefined) return createResultError(op, "login transaction could not be created")
    const cookieR = zitadelPreAuthCookieSerialize(preAuthCookieSecret, { maxAgeSeconds })
    if (!cookieR.success) return createResultError(op, "login transaction could not be created")
    const transactionR = await promiseBoundedRace(
      Promise.resolve().then(() =>
        options.transactions.put({
          state,
          nonce,
          codeVerifier,
          callbackUrl: configR.data.callbackUrl,
          preAuthCookieHash: preAuthCookieHashR.data,
          expiresAt: expiresAtR.data,
        }),
      ),
      options,
    )
    if (!transactionR.success || !transactionR.data.success) {
      return createResultError(op, "login transaction could not be created")
    }
    const authorizationUrl = new URL(discoveryR.data.authorizationEndpoint)
    authorizationUrl.searchParams.set("response_type", "code")
    authorizationUrl.searchParams.set("client_id", configR.data.clientId)
    authorizationUrl.searchParams.set("redirect_uri", configR.data.callbackUrl)
    authorizationUrl.searchParams.set("scope", (configR.data.scope ?? ["openid", "profile", "email"]).join(" "))
    authorizationUrl.searchParams.set("state", state)
    authorizationUrl.searchParams.set("nonce", nonce)
    authorizationUrl.searchParams.set("code_challenge", challenge)
    authorizationUrl.searchParams.set("code_challenge_method", "S256")
    return createResult({ authorizationUrl: authorizationUrl.toString(), state, setCookie: cookieR.data })
  } catch {
    return createResultError(op, "login transaction could not be created")
  }
}
