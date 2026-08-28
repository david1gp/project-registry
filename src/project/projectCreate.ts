import { createResult, createResultErrorCode, type PromiseResult } from "#result"
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

function projectCreateNeedsDefaultDomain(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const caddy = (input as Record<string, unknown>).caddy
  if (!caddy || typeof caddy !== "object" || Array.isArray(caddy)) return false
  return !Array.isArray((caddy as Record<string, unknown>).domains)
}

async function projectCreateDefaultDomain(
  options: ProjectUseCaseOptions,
  owner: string,
  input: unknown,
): PromiseResult<string | null | undefined> {
  if (!projectCreateNeedsDefaultDomain(input)) return createResult(undefined)
  const entryR = await options.repository.getUserDefaultDomain(owner)
  if (!entryR.success) return entryR
  return createResult(entryR.data.domain)
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
  if (owner === undefined) return createResultErrorCode(op, "project owner is required", "request.invalid")

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, owner)
  if (!authorizationR.success) return authorizationR

  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR

  const expectedRevisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, op)
  if (!expectedRevisionR.success) return expectedRevisionR

  const defaultDomainR = await projectCreateDefaultDomain(options, owner, input)
  if (!defaultDomainR.success) return defaultDomainR

  const projectR = projectNormalize(input, {
    projects: snapshotR.data.projects,
    portRange: options.portRange,
    defaultUserDomains: options.defaultUserDomains,
    defaultUserDomain: defaultDomainR.data,
  })
  if (!projectR.success) return projectR

  const repositoryOptions = { actor: actorR.data.username, expectedRevision: expectedRevisionR.data }
  return options.repository.create(projectR.data, repositoryOptions)
}
