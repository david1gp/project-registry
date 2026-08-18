import { createResult, createResultError, type PromiseResult } from "#result"
import type { CsrfTokenStore } from "./CsrfTokenStore.js"

export async function csrfTokenValidate(sessionId: string, token: string, store: CsrfTokenStore): PromiseResult<true> {
  const op = "csrfTokenValidate"
  try {
    const result = await store.validate(sessionId, token)
    if (!result.success) return result
    if (result.success !== true || result.data !== true) return createResultError(op, "CSRF token is invalid")
    return createResult(true)
  } catch {
    return createResultError(op, "CSRF token is invalid")
  }
}
