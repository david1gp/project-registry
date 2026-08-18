import { createResult, createResultError, type PromiseResult } from "#result"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { MutationSecurityOptions } from "./MutationSecurityOptions.js"
import { mutationOriginValidate } from "./mutationOriginValidate.js"

export async function mutationSecurityValidate(options: MutationSecurityOptions): PromiseResult<true> {
  const op = "mutationSecurityValidate"
  const originR = mutationOriginValidate(options.origin, options.expectedOrigin)
  if (!originR.success) return createResultError(op, "mutation request is not authorized")
  if (
    typeof options.sessionId !== "string" ||
    options.sessionId.length === 0 ||
    options.sessionId.length > 256 ||
    typeof options.csrfToken !== "string" ||
    options.csrfToken.length === 0 ||
    options.csrfToken.length > 256
  ) {
    return createResultError(op, "mutation request is not authorized")
  }
  try {
    const csrfR = await promiseBoundedRace(
      Promise.resolve().then(() => options.csrf.validate(options.sessionId, options.csrfToken)),
      options,
    )
    if (!csrfR.success || csrfR.data.success !== true || csrfR.data.data !== true)
      return createResultError(op, "mutation request is not authorized")
    return createResult(true)
  } catch {
    return createResultError(op, "mutation request is not authorized")
  }
}
