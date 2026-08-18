import { createResultError, type PromiseResult } from "#result"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { Project } from "./Project.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
import { projectNormalize } from "./projectNormalize.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"

function projectInputIdentityMatches(input: unknown, key: ProjectKey): boolean | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const owner = record.owner
  const name = record.name
  if (owner !== undefined && typeof owner !== "string") return false
  if (name !== undefined && typeof name !== "string") return false
  if (typeof owner === "string" && owner.trim() !== key.owner) return false
  if (typeof name === "string" && name.trim() !== key.name) return false
  return true
}

function projectEditRecordMerge(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(existing)) merged[key] = value

  for (const [key, value] of Object.entries(patch)) {
    const existingValue = Object.hasOwn(merged, key) ? merged[key] : undefined
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existingValue &&
      typeof existingValue === "object" &&
      !Array.isArray(existingValue)
    ) {
      merged[key] = projectEditRecordMerge(existingValue as Record<string, unknown>, value as Record<string, unknown>)
      continue
    }
    merged[key] = value
  }
  return merged
}

function projectEditInputMerge(existing: Project, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const patch = input as Record<string, unknown>
  const merged = projectEditRecordMerge(existing as unknown as Record<string, unknown>, patch)
  if (patch.owner === undefined) merged.owner = existing.owner
  if (patch.name === undefined) merged.name = existing.name
  return merged
}

export async function projectEdit(
  options: ProjectUseCaseOptions,
  key: ProjectKey,
  input: unknown,
  mutationOptions: ProjectMutationOptions,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectEdit"
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, key.owner)
  if (!authorizationR.success) return authorizationR

  if (projectInputIdentityMatches(input, key) === false) {
    return createResultError(op, "project owner and name are immutable")
  }

  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR
  const existing = snapshotR.data.projects.find((project) => projectKeyEqual(project, key))
  if (!existing) return createResultError(op, "project not found")

  const projectR = projectNormalize(projectEditInputMerge(existing, input), {
    projects: snapshotR.data.projects,
    portRange: options.portRange,
    excludeKey: key,
    excludeProject: existing,
  })
  if (!projectR.success) return projectR
  if (!projectKeyEqual(projectR.data, key)) return createResultError(op, "project owner and name are immutable")

  const expectedRevisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, op)
  if (!expectedRevisionR.success) return expectedRevisionR

  const repositoryOptions = { actor: actorR.data.username, expectedRevision: expectedRevisionR.data }
  return options.repository.edit(key, projectR.data, repositoryOptions)
}
