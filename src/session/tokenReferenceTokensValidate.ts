import { createResult, createResultError, type Result } from "#result"
import { timeMillisecondsValidate } from "../runtime/timeMillisecondsValidate.js"
import type { TokenReferenceTokens } from "./TokenReferenceTokens.js"

export function tokenReferenceTokensValidate(value: unknown): Result<TokenReferenceTokens> {
  const op = "tokenReferenceTokensValidate"
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createResultError(op, "token reference data is invalid")
  }
  const tokens = value as Record<string, unknown>
  if (
    typeof tokens.accessToken !== "string" ||
    tokens.accessToken.length === 0 ||
    tokens.accessToken.length > 8192 ||
    (tokens.refreshToken !== undefined &&
      (typeof tokens.refreshToken !== "string" ||
        tokens.refreshToken.length === 0 ||
        tokens.refreshToken.length > 8192)) ||
    !timeMillisecondsValidate(tokens.expiresAt) ||
    tokens.expiresAt <= 0
  ) {
    return createResultError(op, "token reference data is invalid")
  }
  return createResult({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken as string | undefined,
    expiresAt: tokens.expiresAt,
  })
}
