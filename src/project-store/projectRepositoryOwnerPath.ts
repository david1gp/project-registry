import { gitStorePathIsSafe } from "#git-store"
import { createResult, createResultError, type Result } from "#result"

export function projectRepositoryOwnerPath(owner: unknown): Result<string> {
  const op = "projectRepositoryOwnerPath"
  if (typeof owner !== "string") return createResultError(op, "owner must be a string")

  const ownerHasControlCharacter = [...owner].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (
    owner.length === 0 ||
    owner === "." ||
    owner === ".." ||
    owner === ".git" ||
    ownerHasControlCharacter ||
    /[\\/]/.test(owner)
  ) {
    return createResultError(op, "owner is not a safe path segment", owner)
  }

  const path = `projects/${owner}`
  const safeR = gitStorePathIsSafe(path)
  if (!safeR.success) return safeR
  return createResult(path)
}
