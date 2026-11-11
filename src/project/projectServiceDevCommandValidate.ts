import { createResult, createResultError, type Result } from "#result"

export const projectServiceDevCommandMaxLength = 512

const tokenBodyPattern = /^[A-Za-z0-9_./:+=,@%-]+$/
const placeholderPattern = /\{(port|host)\}/g

/**
 * Validate a per-service dev command and tokenize it into argv. The command
 * is a whitespace-separated argv string with optional {port}/{host}
 * placeholders: no quoting, no shell metacharacters, no absolute or
 * parent-escaping executable path. Substitution happens server-side at spawn
 * time, so the stored string is never interpreted by a shell.
 */
export function projectServiceDevCommandValidate(command: unknown): Result<string[]> {
  const op = "projectServiceDevCommandValidate"
  if (typeof command !== "string" || command.trim() === "") {
    return createResultError(op, "dev command must not be blank")
  }
  if (command.length > projectServiceDevCommandMaxLength) {
    return createResultError(op, "dev command is too long")
  }
  const tokens = command.trim().split(/\s+/)
  const first = tokens[0]
  if (first === undefined) return createResultError(op, "dev command must not be blank")
  if (first.includes("=")) {
    return createResultError(op, "dev command must not contain shell metacharacters")
  }
  for (const token of tokens) {
    const withoutPlaceholders = token.replace(placeholderPattern, "x")
    if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) {
      return createResultError(op, `dev command has an unknown placeholder in ${token}`)
    }
    if (!tokenBodyPattern.test(withoutPlaceholders)) {
      return createResultError(op, "dev command must not contain shell metacharacters")
    }
  }
  if (first.includes("/")) {
    if (first.startsWith("/")) {
      return createResultError(op, "dev command must not escape its project directory")
    }
    if (first.split("/").includes("..")) {
      return createResultError(op, "dev command must not escape its project directory")
    }
  }
  return createResult(tokens)
}
