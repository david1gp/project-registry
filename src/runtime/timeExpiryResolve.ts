import { createResult, createResultError, type Result } from "#result"
import { timeMillisecondsValidate } from "./timeMillisecondsValidate.js"

export function timeExpiryResolve(nowMilliseconds: unknown, maxAgeSeconds: unknown): Result<number> {
  const op = "timeExpiryResolve"
  if (!timeMillisecondsValidate(nowMilliseconds)) return createResultError(op, "runtime time is invalid")
  if (typeof maxAgeSeconds !== "number" || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    return createResultError(op, "runtime lifetime is invalid")
  }
  if (maxAgeSeconds > Math.floor((Number.MAX_SAFE_INTEGER - nowMilliseconds) / 1000)) {
    return createResultError(op, "runtime lifetime overflows")
  }
  return createResult(nowMilliseconds + maxAgeSeconds * 1000)
}
