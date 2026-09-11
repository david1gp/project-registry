import { createResult, type PromiseResult } from "#result"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"
import type { ProjectKey } from "./projectKey.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"
import { projectRevisionValidate } from "./projectRevisionValidate.js"

export async function projectGetUseCase(
  options: ProjectUseCaseOptions,
  key: ProjectKey,
): PromiseResult<{ project: ProjectCanonical; revision: string }> {
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, key.owner)
  if (!authorizationR.success) return authorizationR
  const entryR = await options.repository.get(key)
  if (!entryR.success) return entryR
  const revisionR = projectRevisionValidate(entryR.data.revision, "projectGetUseCase")
  if (!revisionR.success) return revisionR
  const projectR = projectMigrate(entryR.data.project)
  if (!projectR.success) return projectR
  return createResult({ project: projectR.data, revision: revisionR.data })
}
