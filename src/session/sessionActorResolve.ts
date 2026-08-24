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

const sessionIdentityHint = "Sign in again, then retry. If the problem persists, contact an administrator."
const sessionMappingHint =
  "Sign in again, then retry. If the problem persists, ask an administrator to verify your account mapping."
const sessionRoleHint =
  "Sign in again, then retry. If the problem persists, ask an administrator to verify your Project Registry role."

function sessionIdentityError(op: string) {
  return { ...createResultError(op, "session identity is unavailable"), hint: sessionIdentityHint }
}

function sessionMappingError(op: string) {
  return { ...createResultError(op, "session user mapping is unavailable"), hint: sessionMappingHint }
}

function sessionRoleError(op: string) {
  return { ...createResultError(op, "current role is unavailable"), hint: sessionRoleHint }
}

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
      return sessionIdentityError(op)
    }
    const initialNowR = clockNowResolve(options.clock ?? Date.now)
    if (!initialNowR.success) return sessionIdentityError(op)
    const sessionR = await promiseBoundedRace(
      Promise.resolve().then(() => options.sessions.resolve(id)),
      options,
    )
    if (!sessionR.success || sessionR.data.success !== true) return sessionIdentityError(op)
    const sessionRecordR = sessionRecordValidate(sessionR.data.data)
    if (!sessionRecordR.success || sessionRecordR.data.id !== id) {
      return sessionIdentityError(op)
    }
    const session = sessionRecordR.data
    const tokenR = await promiseBoundedRace(
      Promise.resolve().then(() => options.tokenReferences.resolve(session.tokenReference)),
      options,
    )
    if (!tokenR.success || tokenR.data.success !== true) return sessionIdentityError(op)
    const tokensR = tokenReferenceTokensValidate(tokenR.data.data)
    if (!tokensR.success) return sessionIdentityError(op)
    const tokens = tokensR.data
    const tokenExpiresAt = tokens.expiresAt
    const tokenIsCurrent = (): boolean => {
      const nowR = clockNowResolve(options.clock ?? Date.now)
      return nowR.success && session.expiresAt > nowR.data && tokenExpiresAt > nowR.data
    }
    if (!tokenIsCurrent()) {
      return sessionIdentityError(op)
    }
    if (typeof options.identityDirectory.userPreferredUsernameResolve !== "function") {
      return sessionMappingError(op)
    }
    const preferredUsernameR = await promiseBoundedRace(
      Promise.resolve().then(() =>
        options.identityDirectory.userPreferredUsernameResolve(session.subject, tokens.accessToken),
      ),
      options,
    )
    if (!preferredUsernameR.success || preferredUsernameR.data.success !== true || !tokenIsCurrent()) {
      return sessionMappingError(op)
    }
    if (preferredUsernameR.data.data !== session.username) {
      return sessionMappingError(op)
    }
    const usernameR = await preferredUsernameMap(preferredUsernameR.data.data, options.posixUsers, options)
    if (!usernameR.success || !tokenIsCurrent() || usernameR.data !== session.username) {
      return sessionMappingError(op)
    }
    const roleR = await userRoleResolve(session.subject, tokens.accessToken, options.identityDirectory, options)
    if (!roleR.success || !tokenIsCurrent()) return sessionRoleError(op)
    const currentTokenR = await promiseBoundedRace(
      Promise.resolve().then(() => options.tokenReferences.resolve(session.tokenReference)),
      options,
    )
    if (!currentTokenR.success || currentTokenR.data.success !== true) {
      return sessionIdentityError(op)
    }
    if (!tokenReferencesEqual(tokensR, currentTokenR.data.data) || !tokenIsCurrent()) {
      return sessionIdentityError(op)
    }
    const currentSessionR = await promiseBoundedRace(
      Promise.resolve().then(() => options.sessions.resolve(id)),
      options,
    )
    if (!currentSessionR.success || currentSessionR.data.success !== true) {
      return sessionIdentityError(op)
    }
    if (!sessionRecordsEqual(sessionRecordR, currentSessionR.data.data)) {
      return sessionIdentityError(op)
    }
    return createResult({ subject: session.subject, username: session.username, role: roleR.data })
  } catch {
    return sessionIdentityError(op)
  }
}
