import { createResult, createResultError } from "#result"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { randomBytesResultResolve } from "../runtime/randomBytesResultResolve.js"
import { timeExpiryResolve } from "../runtime/timeExpiryResolve.js"
import { timeMillisecondsValidate } from "../runtime/timeMillisecondsValidate.js"
import { randomBytesGenerate } from "./randomBytesGenerate.js"
import type { SessionRecord } from "./SessionRecord.js"
import type { SessionStore } from "./SessionStore.js"
import type { SessionStoreOptions } from "./SessionStoreOptions.js"
import { sessionRecordValidate } from "./sessionRecordValidate.js"
import { tokenReferenceIdValidate } from "./tokenReferenceIdValidate.js"
import { tokenReferenceTokensValidate } from "./tokenReferenceTokensValidate.js"

function sessionIdEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const defaultMaxEntries = 10_000
const maximumMaxEntries = 100_000

function maxEntriesResolve(value: number | undefined): number | undefined {
  const maxEntries = value ?? defaultMaxEntries
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > maximumMaxEntries) return undefined
  return maxEntries
}

function resultHasSuccessData(value: unknown): value is { success: true; data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).success === true &&
    Object.hasOwn(value, "data")
  )
}

function resultIsTrue(value: unknown): value is { success: true; data: true } {
  return resultHasSuccessData(value) && value.data === true
}

export function sessionStoreCreate(options: SessionStoreOptions): SessionStore {
  const clock = options.clock ?? Date.now
  const randomBytes = options.randomBytes ?? randomBytesGenerate
  const maxAgeSeconds = options.maxAgeSeconds ?? 3600
  const sessions = new Map<string, SessionRecord>()
  const maxEntries = maxEntriesResolve(options.maxEntries)

  const expiredEntriesClean = async (now: number): Promise<void> => {
    const tokenReferencesToRemove: string[] = []
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(id)
        tokenReferencesToRemove.push(session.tokenReference)
      }
    }
    for (const tokenReference of tokenReferencesToRemove) {
      try {
        await options.tokenReferences.remove(tokenReference)
      } catch {
        // Expired sessions remain invalid if token-reference cleanup is unavailable.
      }
    }
  }

  const sessionDelete = async (session: SessionRecord, op: string) => {
    if (sessions.get(session.id) === session) sessions.delete(session.id)
    try {
      const tokenR: unknown = await options.tokenReferences.remove(session.tokenReference)
      if (!resultIsTrue(tokenR)) return createResultError(op, "session token reference could not be removed")
    } catch {
      return createResultError(op, "session token reference could not be removed")
    }
    return createResult(true)
  }

  return {
    async create(input, operationOptions = {}) {
      const op = "sessionCreate"
      const initialNowR = clockNowResolve(clock)
      if (!initialNowR.success) return createResultError(op, "session lifetime is invalid")
      if (operationOptions.signal?.aborted) return createResultError(op, "session creation was cancelled")
      await expiredEntriesClean(initialNowR.data)
      if (maxEntries === undefined) return createResultError(op, "session capacity is invalid")
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        typeof input.subject !== "string" ||
        input.subject.length === 0 ||
        input.subject.length > 256 ||
        typeof input.username !== "string" ||
        input.username.length === 0 ||
        input.username.length > 256
      ) {
        return createResultError(op, "session data is invalid")
      }
      const tokenReferenceR = tokenReferenceIdValidate(input.tokenReference)
      if (!tokenReferenceR.success) return createResultError(op, "session data is invalid")
      if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 31_536_000) {
        return createResultError(op, "session lifetime is invalid")
      }
      let tokenR: unknown
      try {
        tokenR = await options.tokenReferences.resolve(tokenReferenceR.data)
      } catch {
        return createResultError(op, "session could not be created")
      }
      if (!resultHasSuccessData(tokenR)) {
        return createResultError(op, "session could not be created")
      }
      const tokensR = tokenReferenceTokensValidate(tokenR.data)
      if (!tokensR.success) return createResultError(op, "session could not be created")
      if (operationOptions.signal?.aborted) return createResultError(op, "session creation was cancelled")
      const createdAtR = clockNowResolve(clock)
      if (!createdAtR.success) return createResultError(op, "session lifetime is invalid")
      const createdAt = createdAtR.data
      const tokenExpiresAt = tokensR.data.expiresAt
      if (tokenExpiresAt <= createdAt) return createResultError(op, "session could not be created")
      await expiredEntriesClean(createdAt)
      if (sessions.size >= maxEntries) return createResultError(op, "session store is full")
      const randomR = randomBytesResultResolve(randomBytes, 32)
      if (!randomR.success) return createResultError(op, "session could not be created")
      const id = sessionIdEncode(randomR.data)
      if (sessions.has(id)) return createResultError(op, "session could not be created")
      const expiryR = timeExpiryResolve(createdAt, maxAgeSeconds)
      if (!expiryR.success) return createResultError(op, "session lifetime is invalid")
      const expiresAt = Math.min(expiryR.data, tokenExpiresAt)
      if (!timeMillisecondsValidate(expiresAt) || expiresAt <= createdAt) {
        return createResultError(op, "session could not be created")
      }
      if (operationOptions.signal?.aborted) return createResultError(op, "session creation was cancelled")
      const session: SessionRecord = {
        id,
        subject: input.subject,
        username: input.username,
        tokenReference: tokenReferenceR.data,
        createdAt,
        expiresAt,
      }
      const sessionR = sessionRecordValidate(session)
      if (!sessionR.success) return createResultError(op, "session could not be created")
      sessions.set(id, sessionR.data)
      return createResult({ ...sessionR.data })
    },
    async resolve(id) {
      const op = "sessionResolve"
      const nowR = clockNowResolve(clock)
      if (!nowR.success) return createResultError(op, "session is unavailable")
      await expiredEntriesClean(nowR.data)
      if (maxEntries === undefined) return createResultError(op, "session capacity is invalid")
      if (typeof id !== "string" || id.length === 0 || id.length > 256)
        return createResultError(op, "session is unavailable")
      const session = sessions.get(id)
      const sessionR = sessionRecordValidate(session)
      if (session === undefined || !sessionR.success) return createResultError(op, "session is unavailable")
      let tokenR: unknown
      try {
        tokenR = await options.tokenReferences.resolve(session.tokenReference)
      } catch {
        await sessionDelete(session, op)
        return createResultError(op, "session is unavailable")
      }
      if (!resultHasSuccessData(tokenR)) {
        await sessionDelete(session, op)
        return createResultError(op, "session is unavailable")
      }
      const tokensR = tokenReferenceTokensValidate(tokenR.data)
      if (!tokensR.success) {
        await sessionDelete(session, op)
        return createResultError(op, "session is unavailable")
      }
      const tokenExpiresAt = tokensR.data.expiresAt
      const afterResolveNowR = clockNowResolve(clock)
      if (!afterResolveNowR.success) {
        await sessionDelete(session, op)
        return createResultError(op, "session is unavailable")
      }
      const currentSession = sessions.get(id)
      if (
        currentSession !== session ||
        !sessionRecordValidate(currentSession).success ||
        sessionR.data.expiresAt <= afterResolveNowR.data ||
        tokenExpiresAt <= afterResolveNowR.data
      ) {
        if (currentSession === session) await sessionDelete(session, op)
        return createResultError(op, "session is unavailable")
      }
      const currentSessionR = sessionRecordValidate(currentSession)
      if (!currentSessionR.success) {
        if (currentSession === session) await sessionDelete(session, op)
        return createResultError(op, "session is unavailable")
      }
      return createResult({ ...currentSessionR.data })
    },
    async revoke(id) {
      const op = "sessionRevoke"
      if (typeof id !== "string" || id.length === 0 || id.length > 256)
        return createResultError(op, "session is unavailable")
      const session = sessions.get(id)
      if (session !== undefined) {
        const revokeR = await sessionDelete(session, op)
        if (!revokeR.success) return revokeR
      }
      return createResult(true)
    },
  }
}
