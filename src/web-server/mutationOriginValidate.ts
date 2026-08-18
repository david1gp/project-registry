import { createResult, createResultError, type Result } from "#result"

export function mutationOriginValidate(origin: string | null | undefined, expectedOrigin: string): Result<true> {
  const op = "mutationOriginValidate"
  if (
    typeof origin !== "string" ||
    typeof expectedOrigin !== "string" ||
    origin.length === 0 ||
    origin.length > 2048 ||
    expectedOrigin.length > 2048
  ) {
    return createResultError(op, "mutation origin is invalid")
  }
  try {
    const expectedUrl = new URL(expectedOrigin)
    if (
      expectedUrl.protocol !== "https:" ||
      expectedUrl.username.length > 0 ||
      expectedUrl.password.length > 0 ||
      expectedUrl.pathname !== "/" ||
      expectedUrl.search.length > 0 ||
      expectedUrl.hash.length > 0 ||
      expectedUrl.origin !== expectedOrigin
    ) {
      return createResultError(op, "mutation origin is invalid")
    }
    if (origin !== expectedOrigin) return createResultError(op, "mutation origin is invalid")
    return createResult(true)
  } catch {
    return createResultError(op, "mutation origin is invalid")
  }
}
