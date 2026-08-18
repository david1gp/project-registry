import { gitStorePathIsSafe } from "#git-store"
import { createResult, createResultError, type Result } from "#result"
import type { ProjectKey } from "../project/projectKey.js"

export function projectRepositoryPath(key: ProjectKey): Result<string> {
  const op = "projectRepositoryPath"
  if (!key || typeof key.owner !== "string" || typeof key.name !== "string") {
    return createResultError(op, "project key must contain owner and name")
  }

  const ownerHasControlCharacter = [...key.owner].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (
    key.owner.length === 0 ||
    key.owner === "." ||
    key.owner === ".." ||
    key.owner === ".git" ||
    ownerHasControlCharacter ||
    /[\\/]/.test(key.owner)
  ) {
    return createResultError(op, "owner is not a safe path segment", key.owner)
  }

  if (key.name === ".git" || !/^[a-z0-9][a-z0-9-]*$/.test(key.name)) {
    return createResultError(op, "name is not a safe project name", key.name)
  }

  const path = `projects/${key.owner}/${key.name}.json`
  const safeR = gitStorePathIsSafe(path)
  if (!safeR.success) return safeR
  return createResult(path)
}
