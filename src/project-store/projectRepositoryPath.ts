import { gitStorePathIsSafe } from "#git-store"
import { createResult, createResultError, type Result } from "#result"
import type { ProjectKey } from "../project/projectKey.js"
import { projectRepositoryOwnerPath } from "./projectRepositoryOwnerPath.js"

export function projectRepositoryPath(key: ProjectKey): Result<string> {
  const op = "projectRepositoryPath"
  if (!key || typeof key.owner !== "string" || typeof key.name !== "string") {
    return createResultError(op, "project key must contain owner and name")
  }

  const ownerPathR = projectRepositoryOwnerPath(key.owner)
  if (!ownerPathR.success) return createResultError(op, ownerPathR.errorMessage, key.owner)

  if (key.name === ".git" || !/^[a-z0-9][a-z0-9-]*$/.test(key.name)) {
    return createResultError(op, "name is not a safe project name", key.name)
  }

  const path = `${ownerPathR.data}/${key.name}.json`
  const safeR = gitStorePathIsSafe(path)
  if (!safeR.success) return safeR
  return createResult(path)
}
