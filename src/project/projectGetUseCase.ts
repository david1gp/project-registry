import { createResult, type PromiseResult } from "#result"
import type { ProjectRepositoryEntry } from "../project-store/ProjectRepositoryEntry.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectKey } from "./projectKey.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"
import { projectRevisionValidate } from "./projectRevisionValidate.js"

export async function projectGetUseCase(
  options: ProjectUseCaseOptions,
  key: ProjectKey,
): PromiseResult<ProjectRepositoryEntry> {
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, key.owner)
  if (!authorizationR.success) return authorizationR
  const entryR = await options.repository.get(key)
  if (!entryR.success) return entryR
  const revisionR = projectRevisionValidate(entryR.data.revision, "projectGetUseCase")
  if (!revisionR.success) return revisionR
  return createResult({ project: entryR.data.project, revision: revisionR.data })
}
