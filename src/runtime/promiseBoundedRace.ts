import { createResult, createResultError, type PromiseResult } from "#result"

const defaultTimeoutMs = 10_000
const maximumTimeoutMs = 120_000

function timeoutIsValid(timeoutMs: unknown): timeoutMs is number {
  return (
    typeof timeoutMs === "number" && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= maximumTimeoutMs
  )
}

function signalIsValid(signal: unknown): signal is AbortSignal {
  return typeof AbortSignal === "function" && signal instanceof AbortSignal
}

export async function promiseBoundedRace<T>(
  operation: Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): PromiseResult<T> {
  const op = "promiseBoundedRace"
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!timeoutIsValid(timeoutMs)) return createResultError(op, "bounded operation timeout is invalid")
  if (options.signal !== undefined && !signalIsValid(options.signal)) {
    return createResultError(op, "bounded operation signal is invalid")
  }
  const signal = options.signal
  if (signal?.aborted) return createResultError(op, "bounded operation was cancelled")

  const cancellationToken = Symbol("bounded operation cancellation")
  let timedOut = false
  let clearTimeout: (() => void) | undefined
  let removeAbortListener: (() => void) | undefined
  try {
    const cancellationPromise = new Promise<typeof cancellationToken>((resolve) => {
      const onAbort = () => resolve(cancellationToken)
      signal?.addEventListener("abort", onAbort, { once: true })
      removeAbortListener = () => signal?.removeEventListener("abort", onAbort)
    })
    const timeoutPromise = new Promise<typeof cancellationToken>((resolve) => {
      const timeoutHandle = globalThis.setTimeout(() => {
        timedOut = true
        resolve(cancellationToken)
      }, timeoutMs)
      clearTimeout = () => globalThis.clearTimeout(timeoutHandle)
    })
    const outcome = await Promise.race([operation, cancellationPromise, timeoutPromise])
    if (outcome === cancellationToken) {
      return createResultError(op, timedOut ? "bounded operation timed out" : "bounded operation was cancelled")
    }
    return createResult(outcome)
  } catch {
    return createResultError(op, "bounded operation failed")
  } finally {
    clearTimeout?.()
    removeAbortListener?.()
  }
}
