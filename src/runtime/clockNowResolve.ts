import { createResult, createResultError, type Result } from "#result"

const maximumMilliseconds = Number.MAX_SAFE_INTEGER

export function clockNowResolve(clock: unknown): Result<number> {
  const op = "clockNowResolve"
  if (typeof clock !== "function") return createResultError(op, "runtime clock is invalid")
  try {
    const now = clock()
    if (!Number.isSafeInteger(now) || now < 0 || now > maximumMilliseconds) {
      return createResultError(op, "runtime clock is invalid")
    }
    return createResult(now)
  } catch {
    return createResultError(op, "runtime clock is invalid")
  }
}
