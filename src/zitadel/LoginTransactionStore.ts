import type { PromiseResult } from "#result"
import type { LoginTransaction } from "./LoginTransaction.js"

export interface LoginTransactionStore {
  put(transaction: LoginTransaction): PromiseResult<true>
  consume(state: string): PromiseResult<LoginTransaction>
}
