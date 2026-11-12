import { createResultErrorCode, type PromiseResult } from "#result"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { Project } from "./Project.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"

export async function projectServiceDelete(
  options: ProjectUseCaseOptions,
  key: ProjectKey,
  service: string,
  mutationOptions: ProjectMutationOptions,
  afterPersistence?: (previous: Project, project: Project) => void,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectServiceDelete"
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR
  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, key.owner)
  if (!authorizationR.success) return authorizationR

  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR
  const existing = snapshotR.data.projects.find((project) => projectKeyEqual(project, key))
  if (existing === undefined) return createResultErrorCode(op, "project not found", "projects.not-found")
  const expectedRevisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, op)
  if (!expectedRevisionR.success) return expectedRevisionR
  const canonicalR = projectMigrate(existing)
  if (!canonicalR.success) return canonicalR
  const services = canonicalR.data.services.filter((entry) => entry.id !== service)
  if (services.length === canonicalR.data.services.length) {
    return createResultErrorCode(op, "service not found", "projects.not-found")
  }
  if (services.length === 0) {
    return createResultErrorCode(
      op,
      "Cannot delete the last service; use 'project-registry project delete <name>' to delete the project.",
      "projects.conflict",
    )
  }

  // Editing services merges by ID; removal must persist the filtered canonical
  // project directly, preserving every sibling and its existing route policy.
  const project = { ...canonicalR.data, services }
  const mutationR = await options.repository.edit(key, project, {
    actor: actorR.data.username,
    expectedRevision: expectedRevisionR.data,
  })
  if (!mutationR.success) return mutationR
  if (mutationR.data.changed) {
    try {
      afterPersistence?.(existing, project)
    } catch {
      // Background integrations must not turn successful persistence into failure.
    }
  }
  return mutationR
}
