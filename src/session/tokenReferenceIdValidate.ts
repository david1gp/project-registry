import { createResult, createResultError, type Result } from "#result"

const maximumTokenReferenceIdLength = 256

export function tokenReferenceIdValidate(value: unknown): Result<string> {
  const op = "tokenReferenceIdValidate"
  if (typeof value !== "string" || value.length === 0 || value.length > maximumTokenReferenceIdLength) {
    return createResultError(op, "token reference ID is invalid")
  }
  return createResult(value)
}
