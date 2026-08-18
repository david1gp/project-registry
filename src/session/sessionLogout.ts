import { createResult, createResultError, type PromiseResult } from "#result"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { SessionLogoutOptions } from "./SessionLogoutOptions.js"
import type { SessionStore } from "./SessionStore.js"
import { sessionCookieClear } from "./sessionCookieClear.js"
import { sessionCookieParse } from "./sessionCookieParse.js"
import { sessionRecordValidate } from "./sessionRecordValidate.js"

function resultIsTrue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).success === true &&
    (value as Record<string, unknown>).data === true
  )
}

export async function sessionLogout(
  cookieHeader: string | null | undefined,
  sessions: SessionStore,
  options: SessionLogoutOptions = {},
): PromiseResult<{ setCookie: string; status: "revoked" | "degraded" }> {
  const cookieR = sessionCookieParse(cookieHeader, options.cookie)
  if (!cookieR.success || options.csrf === undefined || typeof options.csrfToken !== "string") {
    return createResultError("sessionLogout", "logout request is unauthorized")
  }
  const csrf = options.csrf
  const csrfToken = options.csrfToken
  const csrfR = await promiseBoundedRace(
    Promise.resolve().then(() => csrf.validate(cookieR.data, csrfToken)),
    options,
  )
  if (!csrfR.success || !resultIsTrue(csrfR.data))
    return createResultError("sessionLogout", "logout request is unauthorized")
  const clearR = sessionCookieClear(options.cookie)
  if (!clearR.success) return clearR
  let degraded = false
  let tokenReference: string | undefined
  try {
    try {
      const sessionR = await promiseBoundedRace(
        Promise.resolve().then(() => sessions.resolve(cookieR.data)),
        options,
      )
      if (sessionR.success && sessionR.data.success === true) {
        const recordR = sessionRecordValidate(sessionR.data.data)
        if (recordR.success) tokenReference = recordR.data.tokenReference
      }
    } catch {
      degraded = true
    }
    try {
      const revokeCsrfR = await promiseBoundedRace(
        Promise.resolve().then(() => csrf.revoke(cookieR.data)),
        options,
      )
      if (!revokeCsrfR.success || !resultIsTrue(revokeCsrfR.data)) degraded = true
    } catch {
      degraded = true
    }
    try {
      const tokenReferences = options.tokenReferences
      if (tokenReference !== undefined && tokenReferences !== undefined) {
        const reference = tokenReference
        const tokenR = await promiseBoundedRace(
          Promise.resolve().then(() => tokenReferences.remove(reference)),
          options,
        )
        if (!tokenR.success || !resultIsTrue(tokenR.data)) degraded = true
      }
    } catch {
      degraded = true
    }
    try {
      const revokeR = await promiseBoundedRace(
        Promise.resolve().then(() => sessions.revoke(cookieR.data)),
        options,
      )
      if (!revokeR.success || !resultIsTrue(revokeR.data)) degraded = true
    } catch {
      degraded = true
    }
    return createResult({ setCookie: clearR.data, status: degraded ? "degraded" : "revoked" })
  } catch {
    return createResult({ setCookie: clearR.data, status: "degraded" })
  }
}
