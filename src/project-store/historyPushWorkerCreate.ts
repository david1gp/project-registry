import { createResult, createResultError, type PromiseResult } from "#result"
import type { HistoryPushWorker } from "./HistoryPushWorker.js"
import type { HistoryPushStatus } from "./historyPushStatusSchema.js"

type Snapshot = { revision: string; aheadCount: number | null }

export function historyPushWorkerCreate(options: {
  enabled: boolean
  snapshot(): PromiseResult<Snapshot>
  push(revision: string): PromiseResult<void>
  clock?: () => number
  timer?: {
    setTimeout(callback: () => void, delayMs: number): unknown
    clearTimeout(handle: unknown): void
  }
}): HistoryPushWorker {
  const clock = options.clock ?? Date.now
  const timer = options.timer ?? {
    setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as number),
  }
  const state: HistoryPushStatus = {
    enabled: options.enabled,
    pending: false,
    inFlight: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastPushedRevision: null,
    lastError: null,
    consecutiveFailures: 0,
    aheadCount: null,
  }
  let started = false
  let dirty = false
  let startupCheck = false
  let handle: unknown
  let logger: (message: string) => void = console.error

  function timerClear(): void {
    if (handle === undefined) return
    timer.clearTimeout(handle)
    handle = undefined
  }

  function attemptSchedule(delayMs: number): void {
    if (!started || state.inFlight || handle !== undefined) return
    handle = timer.setTimeout(() => {
      handle = undefined
      return attempt()
    }, delayMs)
    ;(handle as { unref?: () => void } | undefined)?.unref?.()
  }

  async function attemptRun(checkOnly: boolean): PromiseResult<string | null> {
    // snapshot is serialized with commits; only the immutable committed SHA
    // leaves that lock. Network I/O must NEVER occupy the mutation queue.
    const snapshotR = await options.snapshot()
    if (!snapshotR.success) return snapshotR
    state.aheadCount = snapshotR.data.aheadCount
    if (!started || snapshotR.data.revision === "" || (checkOnly && snapshotR.data.aheadCount === 0))
      return createResult(null)
    const pushR = await options.push(snapshotR.data.revision)
    if (!pushR.success) return pushR
    return createResult(snapshotR.data.revision)
  }

  async function attempt(): Promise<void> {
    if (!started || state.inFlight) return
    const checkOnly = startupCheck && !dirty
    startupCheck = false
    dirty = false
    state.inFlight = true
    state.pending = true
    state.lastAttemptAt = clock()
    // Git/process adapters are I/O boundaries and may unexpectedly reject.
    const result = await attemptRun(checkOnly).catch((error: unknown) =>
      createResultError("historyPush", error instanceof Error ? error.message : String(error)),
    )
    state.inFlight = false
    if (!result.success) {
      // Git's stderr can include a credential-bearing HTTPS remote URL. This
      // daemon-wide diagnostic is public to status readers, never expose it.
      const message = result.errorMessage.replace(/(https?:\/\/)[^\s/]*@/g, "$1[redacted]@")
      state.lastError = { message, at: clock() }
      state.consecutiveFailures += 1
      state.pending = true
      const mutationArrived = dirty
      dirty = true
      try {
        logger(`history push outcome=failure attempts=${state.consecutiveFailures} reason=${message}`)
      } catch {
        // A broken logger must not disable retries or affect mutations.
      }
      const delays = [30_000, 120_000, 600_000]
      attemptSchedule(mutationArrived ? 0 : delays[Math.min(state.consecutiveFailures - 1, delays.length - 1)]!)
      return
    }
    if (result.data !== null) {
      state.lastSuccessAt = clock()
      state.lastPushedRevision = result.data
      state.lastError = null
      state.consecutiveFailures = 0
      state.aheadCount = dirty ? null : 0
    }
    state.pending = dirty || startupCheck
    if (state.pending) attemptSchedule(0)
  }

  return {
    start: (writeLog) => {
      if (started || !options.enabled) return
      logger = writeLog ?? console.error
      started = true
      startupCheck = true
      state.pending = true
      attemptSchedule(0)
    },
    stop: () => {
      started = false
      timerClear()
      // Do not wait for slow network I/O on shutdown. The next daemon checks
      // the local ahead count; an in-flight attempt cannot schedule more work.
    },
    schedule: () => {
      if (!options.enabled) return
      dirty = true
      state.pending = true
      state.aheadCount = null
      timerClear()
      attemptSchedule(0)
    },
    status: () => ({ ...state, lastError: state.lastError === null ? null : { ...state.lastError } }),
  }
}
