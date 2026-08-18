import { createResult, createResultError, type Result } from "#result"

export function randomBytesResultResolve(randomBytes: unknown, length: number): Result<Uint8Array> {
  const op = "randomBytesResultResolve"
  if (typeof randomBytes !== "function" || !Number.isSafeInteger(length) || length < 1 || length > 4096) {
    return createResultError(op, "secure random result is invalid")
  }
  try {
    const result: unknown = randomBytes(length)
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result) ||
      (result as Record<string, unknown>).success !== true
    ) {
      return createResultError(op, "secure random result is invalid")
    }
    const bytes = (result as Record<string, unknown>).data
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      return createResultError(op, "secure random result is invalid")
    }
    return createResult(bytes)
  } catch {
    return createResultError(op, "secure random result is invalid")
  }
}
