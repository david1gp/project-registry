import { createResult, createResultError } from "#result"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { timeMillisecondsValidate } from "../runtime/timeMillisecondsValidate.js"
import type { LoginTransaction } from "./LoginTransaction.js"
import type { LoginTransactionStore } from "./LoginTransactionStore.js"
import type { LoginTransactionStoreOptions } from "./LoginTransactionStoreOptions.js"

const defaultMaxEntries = 10_000
const maximumMaxEntries = 100_000

function maxEntriesResolve(value: number | undefined): number | undefined {
  const maxEntries = value ?? defaultMaxEntries
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > maximumMaxEntries) return undefined
  return maxEntries
}

export function zitadelLoginTransactionStoreCreate(options: LoginTransactionStoreOptions = {}): LoginTransactionStore {
  const clock = options.clock ?? Date.now
  const transactions = new Map<string, LoginTransaction>()
  const maxEntries = maxEntriesResolve(options.maxEntries)

  const expiredEntriesClean = (now: number): void => {
    for (const [state, transaction] of transactions) {
      if (transaction.expiresAt <= now) transactions.delete(state)
    }
  }

  return {
    async put(transaction) {
      const op = "loginTransactionPut"
      const nowR = clockNowResolve(clock)
      if (!nowR.success) return createResultError(op, "login transaction is invalid")
      const now = nowR.data
      expiredEntriesClean(now)
      if (maxEntries === undefined) return createResultError(op, "login transaction capacity is invalid")
      if (
        typeof transaction !== "object" ||
        transaction === null ||
        Array.isArray(transaction) ||
        typeof transaction.state !== "string" ||
        transaction.state.length !== 43 ||
        typeof transaction.nonce !== "string" ||
        transaction.nonce.length !== 43 ||
        typeof transaction.codeVerifier !== "string" ||
        transaction.codeVerifier.length !== 43 ||
        !/^[A-Za-z0-9_-]{43}$/.test(transaction.state) ||
        !/^[A-Za-z0-9_-]{43}$/.test(transaction.nonce) ||
        !/^[A-Za-z0-9_-]{43}$/.test(transaction.codeVerifier) ||
        typeof transaction.callbackUrl !== "string" ||
        transaction.callbackUrl.length === 0 ||
        transaction.callbackUrl.length > 2048 ||
        typeof transaction.preAuthCookieHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(transaction.preAuthCookieHash) ||
        !timeMillisecondsValidate(transaction.expiresAt) ||
        transaction.expiresAt <= now
      ) {
        return createResultError(op, "login transaction is invalid")
      }
      if (transactions.has(transaction.state)) return createResultError(op, "login transaction is invalid")
      if (transactions.size >= maxEntries) return createResultError(op, "login transaction store is full")
      transactions.set(transaction.state, { ...transaction })
      return createResult(true)
    },
    async consume(state) {
      const op = "loginTransactionConsume"
      const nowR = clockNowResolve(clock)
      if (!nowR.success) return createResultError(op, "login transaction is invalid")
      expiredEntriesClean(nowR.data)
      if (maxEntries === undefined) return createResultError(op, "login transaction capacity is invalid")
      if (typeof state !== "string" || state.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(state))
        return createResultError(op, "login transaction is invalid")
      const transaction = transactions.get(state)
      if (transaction === undefined) return createResultError(op, "login transaction is invalid")
      if (!timeMillisecondsValidate(transaction.expiresAt) || transaction.expiresAt <= nowR.data) {
        transactions.delete(state)
        return createResultError(op, "login transaction is invalid")
      }
      transactions.delete(state)
      return createResult({ ...transaction })
    },
  }
}
