import { createResult, createResultError, type Result } from "#result"

export function randomBytesGenerate(length: number): Result<Uint8Array> {
  const op = "randomBytesGenerate"
  if (!Number.isInteger(length) || length < 1 || length > 4096) {
    return createResultError(op, "random byte length is invalid")
  }
  try {
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    return createResult(bytes)
  } catch {
    return createResultError(op, "secure random generation failed")
  }
}
