import type { PromiseResult } from "#result"
import type { TokenReferenceTokens } from "./TokenReferenceTokens.js"

export interface TokenReferenceStore {
  save(tokens: TokenReferenceTokens, options?: { signal?: AbortSignal }): PromiseResult<string>
  resolve(reference: string): PromiseResult<TokenReferenceTokens>
  remove(reference: string): PromiseResult<true>
}
