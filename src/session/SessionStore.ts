import type { PromiseResult } from "#result"
import type { SessionCreateInput } from "./SessionCreateInput.js"
import type { SessionRecord } from "./SessionRecord.js"

export interface SessionStore {
  create(input: SessionCreateInput, options?: { signal?: AbortSignal }): PromiseResult<SessionRecord>
  resolve(id: string): PromiseResult<SessionRecord>
  revoke(id: string): PromiseResult<true>
}
