import { gitStorePathIsSafe } from "#git-store"
import { createResult, createResultError, type Result } from "#result"
import { projectRepositoryOwnerPath } from "../project-store/projectRepositoryOwnerPath.js"

export function userDefaultDomainPath(owner: unknown): Result<string> {
  const op = "userDefaultDomainPath"
  if (typeof owner !== "string") return createResultError(op, "owner must be a string")

  const ownerR = projectRepositoryOwnerPath(owner)
  if (!ownerR.success) return createResultError(op, ownerR.errorMessage, owner)

  const path = `users/${owner}/default-domain.json`
  const safeR = gitStorePathIsSafe(path)
  if (!safeR.success) return safeR
  return createResult(path)
}
