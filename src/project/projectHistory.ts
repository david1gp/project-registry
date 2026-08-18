import type { GitStoreCommitInfo } from "#git-store"
import type { PromiseResult } from "#result"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectKey } from "./projectKey.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"

export async function projectHistory(
  options: ProjectUseCaseOptions,
  key: ProjectKey,
  limit?: number,
): PromiseResult<GitStoreCommitInfo[]> {
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, key.owner)
  if (!authorizationR.success) return authorizationR
  return options.repository.history(key, limit)
}
