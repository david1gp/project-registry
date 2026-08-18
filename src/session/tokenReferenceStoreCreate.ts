import { createResult, createResultError } from "#result"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { randomBytesResultResolve } from "../runtime/randomBytesResultResolve.js"
import { randomBytesGenerate } from "./randomBytesGenerate.js"
import type { TokenReferenceStore } from "./TokenReferenceStore.js"
import type { TokenReferenceStoreOptions } from "./TokenReferenceStoreOptions.js"
import type { TokenReferenceTokens } from "./TokenReferenceTokens.js"
import { tokenReferenceIdValidate } from "./tokenReferenceIdValidate.js"
import { tokenReferenceTokensValidate } from "./tokenReferenceTokensValidate.js"

function tokenReferenceEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const defaultMaxEntries = 10_000
const maximumMaxEntries = 100_000

function maxEntriesResolve(value: number | undefined): number | undefined {
  const maxEntries = value ?? defaultMaxEntries
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > maximumMaxEntries) return undefined
  return maxEntries
}

export function tokenReferenceStoreCreate(options: TokenReferenceStoreOptions = {}): TokenReferenceStore {
  const clock = options.clock ?? Date.now
  const randomBytes = options.randomBytes ?? randomBytesGenerate
  const tokensByReference = new Map<string, TokenReferenceTokens>()
  const maxEntries = maxEntriesResolve(options.maxEntries)

  const expiredEntriesClean = (now: number): void => {
    for (const [reference, tokens] of tokensByReference) {
      if (typeof tokens.expiresAt !== "number" || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= now) {
        tokensByReference.delete(reference)
      }
    }
  }

  return {
    async save(tokens, operationOptions = {}) {
      const op = "tokenReferenceSave"
      const nowR = clockNowResolve(clock)
      if (!nowR.success) return createResultError(op, "token reference data is invalid")
      if (operationOptions.signal?.aborted) return createResultError(op, "token reference creation was cancelled")
      const now = nowR.data
      expiredEntriesClean(now)
      if (maxEntries === undefined) return createResultError(op, "token reference capacity is invalid")
      const tokensR = tokenReferenceTokensValidate(tokens)
      if (!tokensR.success || tokensR.data.expiresAt <= now) {
        return createResultError(op, "token reference data is invalid")
      }
      if (tokensByReference.size >= maxEntries) return createResultError(op, "token reference store is full")
      const randomR = randomBytesResultResolve(randomBytes, 32)
      if (!randomR.success) return createResultError(op, "token reference could not be created")
      const reference = tokenReferenceEncode(randomR.data)
      const referenceR = tokenReferenceIdValidate(reference)
      if (!referenceR.success || tokensByReference.has(referenceR.data))
        return createResultError(op, "token reference could not be created")
      if (operationOptions.signal?.aborted) return createResultError(op, "token reference creation was cancelled")
      tokensByReference.set(referenceR.data, tokensR.data)
      return createResult(referenceR.data)
    },
    async resolve(reference) {
      const op = "tokenReferenceResolve"
      const nowR = clockNowResolve(clock)
      if (!nowR.success) return createResultError(op, "token reference is unavailable")
      expiredEntriesClean(nowR.data)
      if (maxEntries === undefined) return createResultError(op, "token reference capacity is invalid")
      const referenceR = tokenReferenceIdValidate(reference)
      if (!referenceR.success) {
        return createResultError(op, "token reference is unavailable")
      }
      const tokens = tokensByReference.get(referenceR.data)
      if (tokens === undefined) return createResultError(op, "token reference is unavailable")
      const tokensR = tokenReferenceTokensValidate(tokens)
      if (!tokensR.success) {
        tokensByReference.delete(referenceR.data)
        return createResultError(op, "token reference is unavailable")
      }
      return createResult(tokensR.data)
    },
    async remove(reference) {
      const op = "tokenReferenceRemove"
      const referenceR = tokenReferenceIdValidate(reference)
      if (!referenceR.success) {
        return createResultError(op, "token reference is unavailable")
      }
      tokensByReference.delete(referenceR.data)
      return createResult(true)
    },
  }
}
