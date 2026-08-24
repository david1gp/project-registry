import { createResult, createResultError, type PromiseResult } from "#result"
import { preferredUsernameMap } from "../identity/preferredUsernameMap.js"
import { userRoleResolve } from "../identity/userRoleResolve.js"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import { timeMillisecondsValidate } from "../runtime/timeMillisecondsValidate.js"
import { sessionCookieSerialize } from "../session/sessionCookieSerialize.js"
import { sessionRecordValidate } from "../session/sessionRecordValidate.js"
import { tokenReferenceIdValidate } from "../session/tokenReferenceIdValidate.js"
import type { ZitadelCallbackOptions } from "./ZitadelCallbackOptions.js"
import type { ZitadelCallbackResult } from "./ZitadelCallbackResult.js"
import { zitadelConfigValidate } from "./zitadelConfigValidate.js"
import { zitadelDiscoveryFetch } from "./zitadelDiscoveryFetch.js"
import { zitadelIdTokenValidate } from "./zitadelIdTokenValidate.js"
import { zitadelJwksFetch } from "./zitadelJwksFetch.js"
import { zitadelPreAuthCookieClear } from "./zitadelPreAuthCookieClear.js"
import { zitadelPreAuthCookieHash } from "./zitadelPreAuthCookieHash.js"
import { zitadelPreAuthCookieParse } from "./zitadelPreAuthCookieParse.js"
import { zitadelTokenExchange } from "./zitadelTokenExchange.js"

const loginRetryHint = "Restart sign-in, then retry."
const loginProviderHint = "Retry sign-in. If the problem persists, contact an administrator."
const loginMappingHint = "Sign in with an account mapped to a local user, or contact an administrator."
const loginRoleHint = "Ask an administrator to grant your account a Project Registry role, then sign in again."

function callbackError(op: string, message: string, hint = loginRetryHint) {
  const clearR = zitadelPreAuthCookieClear()
  return {
    ...createResultError(op, message, clearR.success ? clearR.data : null),
    hint,
  }
}

async function callbackCleanup(
  sessionId: string | undefined,
  tokenReference: string | undefined,
  options: ZitadelCallbackOptions,
): Promise<void> {
  const cleanupOperations: Promise<unknown>[] = []
  if (sessionId !== undefined) {
    cleanupOperations.push(
      promiseBoundedRace(
        Promise.resolve().then(() => options.sessions.revoke(sessionId)),
        options,
      ),
    )
  }
  if (tokenReference !== undefined) {
    cleanupOperations.push(
      promiseBoundedRace(
        Promise.resolve().then(() => options.tokenReferences.remove(tokenReference)),
        options,
      ),
    )
  }
  await Promise.allSettled(cleanupOperations)
}

function callbackTokenReferenceResolve(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  if (result.success !== true) return undefined
  const referenceR = tokenReferenceIdValidate(result.data)
  return referenceR.success ? referenceR.data : undefined
}

function callbackSessionRecordResolve(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  if (result.success !== true) return undefined
  const sessionR = sessionRecordValidate(result.data)
  return sessionR.success ? sessionR.data : undefined
}

function callbackLateTokenReferenceCleanup(operation: Promise<unknown>, options: ZitadelCallbackOptions): void {
  void operation.then(
    async (value) => {
      const reference = callbackTokenReferenceResolve(value)
      if (reference === undefined) return
      try {
        await options.tokenReferences.remove(reference)
      } catch {
        // Late cleanup is best effort.
      }
    },
    () => undefined,
  )
}

function callbackLateSessionCleanup(
  operation: Promise<unknown>,
  tokenReference: string,
  options: ZitadelCallbackOptions,
): void {
  void operation.then(
    async (value) => {
      const session = callbackSessionRecordResolve(value)
      if (session === undefined) return
      void Promise.resolve()
        .then(() => options.sessions.revoke(session.id))
        .catch(() => undefined)
      void Promise.resolve()
        .then(() => options.tokenReferences.remove(tokenReference))
        .catch(() => undefined)
      if (session.tokenReference !== tokenReference) {
        void Promise.resolve()
          .then(() => options.tokenReferences.remove(session.tokenReference))
          .catch(() => undefined)
      }
    },
    () => undefined,
  )
}

export async function zitadelCallbackHandle(options: ZitadelCallbackOptions): PromiseResult<ZitadelCallbackResult> {
  const op = "zitadelCallbackHandle"
  const configR = zitadelConfigValidate(options.config)
  if (!configR.success) return callbackError(op, "login configuration is invalid")
  if (options.callbackUrl !== configR.data.callbackUrl || !(options.query instanceof URLSearchParams)) {
    return callbackError(op, "login callback is invalid")
  }
  const state = options.query.get("state")
  const code = options.query.get("code")
  const error = options.query.get("error")
  if (state === null || state.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    return callbackError(op, "login callback is invalid")
  }
  if (code !== null && (code.length === 0 || code.length > 4096)) return callbackError(op, "login callback is invalid")
  if (error !== null && error.length > 256) return callbackError(op, "login callback is invalid")
  const clock = options.clock ?? Date.now
  const initialNowR = clockNowResolve(clock)
  if (!initialNowR.success) return callbackError(op, "login session could not be created")
  let sessionId: string | undefined
  let tokenReference: string | undefined
  try {
    const transactionR = await promiseBoundedRace(
      Promise.resolve().then(() => options.transactions.consume(state)),
      options,
    )
    if (
      !transactionR.success ||
      transactionR.data.success !== true ||
      transactionR.data.data.callbackUrl !== configR.data.callbackUrl
    ) {
      return callbackError(op, "login callback is invalid")
    }
    const preAuthCookieR = zitadelPreAuthCookieParse(options.cookieHeader)
    if (!preAuthCookieR.success) return callbackError(op, "login callback is invalid")
    const preAuthCookieHashR = await zitadelPreAuthCookieHash(preAuthCookieR.data)
    if (!preAuthCookieHashR.success || preAuthCookieHashR.data !== transactionR.data.data.preAuthCookieHash) {
      return callbackError(op, "login callback is invalid")
    }
    if (error !== null || code === null || code.length === 0) {
      return callbackError(op, "login callback is invalid")
    }
    const discoveryR = await zitadelDiscoveryFetch(configR.data, options.http, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxBodyBytes: options.maxBodyBytes,
    })
    if (!discoveryR.success) return callbackError(op, "login provider is unavailable", loginProviderHint)
    const tokensR = await zitadelTokenExchange({
      config: configR.data,
      discovery: discoveryR.data,
      http: options.http,
      code,
      codeVerifier: transactionR.data.data.codeVerifier,
      clock,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxBodyBytes: options.maxBodyBytes,
    })
    if (!tokensR.success) return callbackError(op, "login provider rejected the callback", loginProviderHint)
    const jwksR = await zitadelJwksFetch(discoveryR.data.jwksUri, options.http, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxBodyBytes: options.maxBodyBytes,
    })
    if (!jwksR.success) return callbackError(op, "login provider is unavailable", loginProviderHint)
    const claimsR = await zitadelIdTokenValidate(
      tokensR.data.idToken,
      configR.data,
      transactionR.data.data.nonce,
      jwksR.data,
      clock,
    )
    if (!claimsR.success) return callbackError(op, "login provider returned an invalid identity", loginProviderHint)
    const tokenExpiresAt = tokensR.data.expiresAt ?? claimsR.data.expiresAt
    const expiresAt = Math.min(tokenExpiresAt, claimsR.data.expiresAt)
    const tokenIsCurrent = (): boolean => {
      const nowR = clockNowResolve(clock)
      return nowR.success && timeMillisecondsValidate(expiresAt) && expiresAt > nowR.data
    }
    const currentUsernameR = await promiseBoundedRace(
      Promise.resolve().then(() =>
        options.identityDirectory.userPreferredUsernameResolve(claimsR.data.subject, tokensR.data.accessToken),
      ),
      options,
    )
    if (!currentUsernameR.success || currentUsernameR.data.success !== true || !tokenIsCurrent()) {
      return callbackError(op, "login user mapping is unavailable", loginMappingHint)
    }
    if (currentUsernameR.data.data !== claimsR.data.preferredUsername) {
      return callbackError(op, "login user mapping is unavailable", loginMappingHint)
    }
    const usernameR = await preferredUsernameMap(claimsR.data.preferredUsername, options.posixUsers, options)
    if (!usernameR.success || !tokenIsCurrent())
      return callbackError(op, "login user mapping is unavailable", loginMappingHint)
    const roleR = await userRoleResolve(
      claimsR.data.subject,
      tokensR.data.accessToken,
      options.identityDirectory,
      options,
    )
    if (!roleR.success || !tokenIsCurrent()) return callbackError(op, "login user role is unavailable", loginRoleHint)
    if (!timeMillisecondsValidate(expiresAt)) {
      return callbackError(op, "login session could not be created")
    }
    const tokenSaveOperation = Promise.resolve().then(() =>
      options.tokenReferences.save(
        {
          accessToken: tokensR.data.accessToken,
          refreshToken: tokensR.data.refreshToken,
          expiresAt,
        },
        { signal: options.signal },
      ),
    )
    const tokenR = await promiseBoundedRace(tokenSaveOperation, options)
    if (!tokenR.success) {
      callbackLateTokenReferenceCleanup(tokenSaveOperation, options)
      return callbackError(op, "login session could not be created")
    }
    if (tokenR.data.success !== true) return callbackError(op, "login session could not be created")
    const tokenReferenceR = tokenReferenceIdValidate(tokenR.data.data)
    if (!tokenReferenceR.success) return callbackError(op, "login session could not be created")
    const tokenReferenceValue = tokenReferenceR.data
    tokenReference = tokenReferenceValue
    if (!tokenIsCurrent()) {
      await callbackCleanup(undefined, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    const sessionCreateOperation = Promise.resolve().then(() =>
      options.sessions.create(
        {
          subject: claimsR.data.subject,
          username: usernameR.data,
          tokenReference: tokenReferenceValue,
        },
        { signal: options.signal },
      ),
    )
    const sessionR = await promiseBoundedRace(sessionCreateOperation, options)
    if (!sessionR.success) {
      callbackLateSessionCleanup(sessionCreateOperation, tokenReferenceValue, options)
      await callbackCleanup(undefined, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    if (sessionR.data.success !== true) {
      await callbackCleanup(undefined, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    const sessionRecordR = sessionRecordValidate(sessionR.data.data)
    if (
      !sessionRecordR.success ||
      sessionRecordR.data.subject !== claimsR.data.subject ||
      sessionRecordR.data.username !== usernameR.data ||
      sessionRecordR.data.tokenReference !== tokenReferenceValue
    ) {
      await callbackCleanup(undefined, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    const sessionRecord = sessionRecordR.data
    sessionId = sessionRecord.id
    if (!tokenIsCurrent()) {
      await callbackCleanup(sessionRecord.id, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    const sessionNowR = clockNowResolve(clock)
    if (!sessionNowR.success || sessionRecord.expiresAt <= sessionNowR.data) {
      await callbackCleanup(sessionRecord.id, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    const cookieR = sessionCookieSerialize(sessionRecord.id, {
      ...options.cookie,
      maxAgeSeconds: Math.max(1, Math.ceil((sessionRecord.expiresAt - sessionNowR.data) / 1000)),
    })
    if (!cookieR.success) {
      await callbackCleanup(sessionRecord.id, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    const clearPreAuthCookieR = zitadelPreAuthCookieClear()
    if (!clearPreAuthCookieR.success) {
      await callbackCleanup(sessionRecord.id, tokenReferenceValue, options)
      return callbackError(op, "login session could not be created")
    }
    return createResult({
      setCookie: cookieR.data,
      clearPreAuthCookie: clearPreAuthCookieR.data,
      subject: claimsR.data.subject,
      username: usernameR.data,
      expiresAt: sessionRecord.expiresAt,
    })
  } catch {
    await callbackCleanup(sessionId, tokenReference, options)
    return callbackError(op, "login callback could not be completed")
  }
}
