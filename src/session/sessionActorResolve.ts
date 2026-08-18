import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { Actor } from "../access/Actor.js"
import { preferredUsernameMap } from "../identity/preferredUsernameMap.js"
import { userRoleResolve } from "../identity/userRoleResolve.js"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { SessionActorResolveOptions } from "./SessionActorResolveOptions.js"
import type { SessionRecord } from "./SessionRecord.js"
import { sessionRecordValidate } from "./sessionRecordValidate.js"
import type { TokenReferenceTokens } from "./TokenReferenceTokens.js"
import { tokenReferenceTokensValidate } from "./tokenReferenceTokensValidate.js"

function sessionRecordsEqual(left: Result<SessionRecord>, right: unknown): boolean {
  if (!left.success) return false
  const rightR = sessionRecordValidate(right)
  return (
    rightR.success &&
    left.data.id === rightR.data.id &&
    left.data.subject === rightR.data.subject &&
    left.data.username === rightR.data.username &&
    left.data.tokenReference === rightR.data.tokenReference &&
    left.data.createdAt === rightR.data.createdAt &&
    left.data.expiresAt === rightR.data.expiresAt
  )
}

function tokenReferencesEqual(left: Result<TokenReferenceTokens>, right: unknown): boolean {
  if (!left.success) return false
  const rightR = tokenReferenceTokensValidate(right)
  return (
    rightR.success &&
    left.data.accessToken === rightR.data.accessToken &&
    left.data.refreshToken === rightR.data.refreshToken &&
    left.data.expiresAt === rightR.data.expiresAt
  )
}

export async function sessionActorResolve(id: string, options: SessionActorResolveOptions): PromiseResult<Actor> {
  const op = "sessionActorResolve"
  try {
    if (typeof id !== "string" || id.length === 0 || id.length > 256) {
      return createResultError(op, "session identity is unavailable")
    }
    const initialNowR = clockNowResolve(options.clock ?? Date.now)
    if (!initialNowR.success) return createResultError(op, "session identity is unavailable")
    const sessionR = await promiseBoundedRace(
      Promise.resolve().then(() => options.sessions.resolve(id)),
      options,
    )
    if (!sessionR.success || sessionR.data.success !== true)
      return createResultError(op, "session identity is unavailable")
    const sessionRecordR = sessionRecordValidate(sessionR.data.data)
    if (!sessionRecordR.success || sessionRecordR.data.id !== id) {
      return createResultError(op, "session identity is unavailable")
    }
    const session = sessionRecordR.data
    const tokenR = await promiseBoundedRace(
      Promise.resolve().then(() => options.tokenReferences.resolve(session.tokenReference)),
      options,
    )
    if (!tokenR.success || tokenR.data.success !== true) return createResultError(op, "session identity is unavailable")
    const tokensR = tokenReferenceTokensValidate(tokenR.data.data)
    if (!tokensR.success) return createResultError(op, "session identity is unavailable")
    const tokens = tokensR.data
    const tokenExpiresAt = tokens.expiresAt
    const tokenIsCurrent = (): boolean => {
      const nowR = clockNowResolve(options.clock ?? Date.now)
      return nowR.success && session.expiresAt > nowR.data && tokenExpiresAt > nowR.data
    }
    if (!tokenIsCurrent()) {
      return createResultError(op, "session identity is unavailable")
    }
    if (typeof options.identityDirectory.userPreferredUsernameResolve !== "function") {
      return createResultError(op, "session user mapping is unavailable")
    }
    const preferredUsernameR = await promiseBoundedRace(
      Promise.resolve().then(() =>
        options.identityDirectory.userPreferredUsernameResolve(session.subject, tokens.accessToken),
      ),
      options,
    )
    if (!preferredUsernameR.success || preferredUsernameR.data.success !== true || !tokenIsCurrent()) {
      return createResultError(op, "session user mapping is unavailable")
    }
    if (preferredUsernameR.data.data !== session.username) {
      return createResultError(op, "session user mapping is unavailable")
    }
    const usernameR = await preferredUsernameMap(preferredUsernameR.data.data, options.posixUsers, options)
    if (!usernameR.success || !tokenIsCurrent() || usernameR.data !== session.username) {
      return createResultError(op, "session user mapping is unavailable")
    }
    const roleR = await userRoleResolve(session.subject, tokens.accessToken, options.identityDirectory, options)
    if (!roleR.success || !tokenIsCurrent()) return createResultError(op, "current role is unavailable")
    const currentTokenR = await promiseBoundedRace(
      Promise.resolve().then(() => options.tokenReferences.resolve(session.tokenReference)),
      options,
    )
    if (!currentTokenR.success || currentTokenR.data.success !== true) {
      return createResultError(op, "session identity is unavailable")
    }
    if (!tokenReferencesEqual(tokensR, currentTokenR.data.data) || !tokenIsCurrent()) {
      return createResultError(op, "session identity is unavailable")
    }
    const currentSessionR = await promiseBoundedRace(
      Promise.resolve().then(() => options.sessions.resolve(id)),
      options,
    )
    if (!currentSessionR.success || currentSessionR.data.success !== true) {
      return createResultError(op, "session identity is unavailable")
    }
    if (!sessionRecordsEqual(sessionRecordR, currentSessionR.data.data)) {
      return createResultError(op, "session identity is unavailable")
    }
    return createResult({ subject: session.subject, username: session.username, role: roleR.data })
  } catch {
    return createResultError(op, "session identity is unavailable")
  }
}
