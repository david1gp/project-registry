import { createResult, createResultError } from "#result"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { randomBytesResultResolve } from "../runtime/randomBytesResultResolve.js"
import { timeExpiryResolve } from "../runtime/timeExpiryResolve.js"
import { timeMillisecondsValidate } from "../runtime/timeMillisecondsValidate.js"
import type { CsrfTokenStore } from "./CsrfTokenStore.js"
import type { CsrfTokenStoreOptions } from "./CsrfTokenStoreOptions.js"
import { randomBytesGenerate } from "./randomBytesGenerate.js"

type StoredToken = {
  hash: Uint8Array
  expiresAt: number
}

function csrfTokenEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

async function csrfTokenHash(token: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))
  } catch {
    return undefined
  }
}

function csrfTokenHashEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

const defaultMaxEntries = 10_000
const maximumMaxEntries = 100_000
const maximumSessionIdLength = 256
const maximumTokenInputLength = 256

function maxEntriesResolve(value: number | undefined): number | undefined {
  const maxEntries = value ?? defaultMaxEntries
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > maximumMaxEntries) return undefined
  return maxEntries
}

function storedTokenIsValid(value: unknown): value is StoredToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const token = value as Record<string, unknown>
  return token.hash instanceof Uint8Array && token.hash.length === 32 && timeMillisecondsValidate(token.expiresAt)
}

export function csrfTokenStoreCreate(options: CsrfTokenStoreOptions = {}): CsrfTokenStore {
  const clock = options.clock ?? Date.now
  const randomBytes = options.randomBytes ?? randomBytesGenerate
  const maxAgeSeconds = options.maxAgeSeconds ?? 3600
  const tokens = new Map<string, StoredToken>()
  const maxEntries = maxEntriesResolve(options.maxEntries)
  const generations = new Map<string, { generation: object; inFlight: number }>()

  const generationStart = (sessionId: string): { generation: object; inFlight: number } => {
    const state = generations.get(sessionId)
    if (state !== undefined) {
      state.inFlight += 1
      return state
    }
    const nextState = { generation: {}, inFlight: 1 }
    generations.set(sessionId, nextState)
    return nextState
  }

  const generationFinish = (sessionId: string, state: { generation: object; inFlight: number }): void => {
    const current = generations.get(sessionId)
    if (current !== state) return
    state.inFlight -= 1
    if (state.inFlight <= 0 && !tokens.has(sessionId)) generations.delete(sessionId)
  }

  const generationAdvance = (sessionId: string, state: { generation: object; inFlight: number }): void => {
    if (generations.get(sessionId) === state) state.generation = {}
  }

  const expiredEntriesClean = (now: number): void => {
    for (const [sessionId, token] of tokens) {
      if (token.expiresAt <= now) {
        tokens.delete(sessionId)
        const state = generations.get(sessionId)
        if (state !== undefined && state.inFlight <= 0) generations.delete(sessionId)
      }
    }
  }

  return {
    async issue(sessionId) {
      const op = "csrfTokenIssue"
      const initialNowR = clockNowResolve(clock)
      if (!initialNowR.success) return createResultError(op, "CSRF token lifetime is invalid")
      expiredEntriesClean(initialNowR.data)
      if (maxEntries === undefined) return createResultError(op, "CSRF token capacity is invalid")
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > maximumSessionIdLength)
        return createResultError(op, "CSRF session is invalid")
      if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 31_536_000) {
        return createResultError(op, "CSRF token lifetime is invalid")
      }
      const state = generationStart(sessionId)
      const generation = state.generation
      try {
        const randomR = randomBytesResultResolve(randomBytes, 32)
        if (!randomR.success) return createResultError(op, "CSRF token could not be created")
        const token = csrfTokenEncode(randomR.data)
        const hash = await csrfTokenHash(token)
        if (hash === undefined) return createResultError(op, "CSRF token could not be created")
        const nowR = clockNowResolve(clock)
        if (!nowR.success || generations.get(sessionId) !== state || state.generation !== generation) {
          return createResultError(op, "CSRF token could not be created")
        }
        const now = nowR.data
        expiredEntriesClean(now)
        if (!tokens.has(sessionId) && tokens.size >= maxEntries)
          return createResultError(op, "CSRF token store is full")
        const expiresAtR = timeExpiryResolve(now, maxAgeSeconds)
        if (!expiresAtR.success) return createResultError(op, "CSRF token lifetime is invalid")
        tokens.set(sessionId, { hash, expiresAt: expiresAtR.data })
        generationAdvance(sessionId, state)
        return createResult(token)
      } finally {
        generationFinish(sessionId, state)
      }
    },
    async validate(sessionId, token) {
      const op = "csrfTokenValidate"
      if (maxEntries === undefined) return createResultError(op, "CSRF token capacity is invalid")
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        sessionId.length > maximumSessionIdLength ||
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > maximumTokenInputLength
      ) {
        return createResultError(op, "CSRF token is invalid")
      }
      const initialNowR = clockNowResolve(clock)
      if (!initialNowR.success) return createResultError(op, "CSRF token is invalid")
      expiredEntriesClean(initialNowR.data)
      const state = generations.get(sessionId)
      if (state === undefined) return createResultError(op, "CSRF token is invalid")
      const generation = state.generation
      const hash = await csrfTokenHash(token)
      if (hash === undefined) return createResultError(op, "CSRF token is invalid")
      const nowR = clockNowResolve(clock)
      if (!nowR.success || generations.get(sessionId)?.generation !== generation)
        return createResultError(op, "CSRF token is invalid")
      const now = nowR.data
      expiredEntriesClean(now)
      const stored = tokens.get(sessionId)
      if (
        stored === undefined ||
        !storedTokenIsValid(stored) ||
        now >= stored.expiresAt ||
        !csrfTokenHashEqual(stored.hash, hash)
      ) {
        return createResultError(op, "CSRF token is invalid")
      }
      return createResult(true)
    },
    async revoke(sessionId) {
      const op = "csrfTokenRevoke"
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > maximumSessionIdLength)
        return createResultError(op, "CSRF session is invalid")
      tokens.delete(sessionId)
      const state = generations.get(sessionId)
      if (state === undefined) return createResult(true)
      state.generation = {}
      if (state.inFlight <= 0) generations.delete(sessionId)
      return createResult(true)
    },
  }
}
