import type { PromiseResult } from "#result"
import type { CsrfTokenStore } from "./CsrfTokenStore.js"

export function csrfTokenIssue(sessionId: string, store: CsrfTokenStore): PromiseResult<string> {
  return store.issue(sessionId)
}
