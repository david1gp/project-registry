import { createResultError, type PromiseResult } from "#result"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
import { projectNormalize } from "./projectNormalize.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"

function projectInputOwner(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const owner = (input as Record<string, unknown>).owner
  if (typeof owner !== "string") return undefined
  const normalizedOwner = owner.trim()
  return normalizedOwner === "" ? undefined : normalizedOwner
}

export async function projectCreate(
  options: ProjectUseCaseOptions,
  input: unknown,
  mutationOptions: ProjectMutationOptions,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectCreate"
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR

  const owner = projectInputOwner(input)
  if (owner === undefined) return createResultError(op, "project owner is required")

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, owner)
  if (!authorizationR.success) return authorizationR

  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR

  const expectedRevisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, op)
  if (!expectedRevisionR.success) return expectedRevisionR

  const projectR = projectNormalize(input, {
    projects: snapshotR.data.projects,
    portRange: options.portRange,
  })
  if (!projectR.success) return projectR

  const repositoryOptions = { actor: actorR.data.username, expectedRevision: expectedRevisionR.data }
  return options.repository.create(projectR.data, repositoryOptions)
}
