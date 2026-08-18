import type { PromiseResult } from "#result"

export interface CsrfTokenStore {
  issue(sessionId: string): PromiseResult<string>
  validate(sessionId: string, token: string): PromiseResult<true>
  revoke(sessionId: string): PromiseResult<true>
}
