import { createResultError, type PromiseResult } from "#result"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"

export async function projectDelete(
  options: ProjectUseCaseOptions,
  key: ProjectKey,
  mutationOptions: ProjectMutationOptions,
): PromiseResult<ProjectRepositoryMutation> {
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, key.owner)
  if (!authorizationR.success) return authorizationR

  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR
  if (!snapshotR.data.projects.some((project) => projectKeyEqual(project, key))) {
    return createResultError("projectDelete", "project not found")
  }

  const expectedRevisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, "projectDelete")
  if (!expectedRevisionR.success) return expectedRevisionR

  const repositoryOptions = { actor: actorR.data.username, expectedRevision: expectedRevisionR.data }
  return options.repository.delete(key, repositoryOptions)
}
