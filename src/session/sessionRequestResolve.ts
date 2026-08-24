import { createResultError, type PromiseResult } from "#result"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { SessionCookieOptions } from "./SessionCookieOptions.js"
import type { SessionRecord } from "./SessionRecord.js"
import type { SessionStore } from "./SessionStore.js"
import { sessionCookieParse } from "./sessionCookieParse.js"
import { sessionRecordValidate } from "./sessionRecordValidate.js"

const sessionRetryHint = "Sign in again, then retry. If the problem persists, contact an administrator."

function sessionError(op: string) {
  return { ...createResultError(op, "session is unavailable"), hint: sessionRetryHint }
}

export async function sessionRequestResolve(
  cookieHeader: string | null | undefined,
  sessions: SessionStore,
  cookieOptions: SessionCookieOptions = {},
  operationOptions: { timeoutMs?: number; signal?: AbortSignal } = {},
): PromiseResult<SessionRecord> {
  const op = "sessionRequestResolve"
  const cookieR = sessionCookieParse(cookieHeader, cookieOptions)
  if (!cookieR.success) return sessionError(op)
  try {
    const sessionR = await promiseBoundedRace(
      Promise.resolve().then(() => sessions.resolve(cookieR.data)),
      operationOptions,
    )
    if (!sessionR.success || sessionR.data.success !== true) return sessionError(op)
    const recordR = sessionRecordValidate(sessionR.data.data)
    if (!recordR.success || recordR.data.id !== cookieR.data) return sessionError(op)
    return recordR
  } catch {
    return sessionError(op)
  }
}
