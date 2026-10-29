import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { Project } from "./Project.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import { projectCanonicalNormalize } from "./projectCanonicalNormalize.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
import { projectNetworkVisibilityDefault } from "./projectNetworkVisibilityDefault.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"
import { projectTailscalePrivateRoutesValidate } from "./projectTailscalePrivateRoutesValidate.js"

function projectCreateVisibilityDefaultApply(input: unknown, owner: string): unknown {
  if (projectNetworkVisibilityDefault(owner) !== "private") return input
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  if (Array.isArray(record.services)) {
    const services = record.services.map((service) => {
      if (!service || typeof service !== "object" || Array.isArray(service)) return service
      const serviceRecord = service as Record<string, unknown>
      const caddy = serviceRecord.caddy
      if (!caddy || typeof caddy !== "object" || Array.isArray(caddy)) return service
      const caddyRecord = caddy as Record<string, unknown>
      if (caddyRecord.networkVisibility !== undefined) return service
      return { ...serviceRecord, caddy: { ...caddyRecord, networkVisibility: "private" } }
    })
    return { ...record, services }
  }
  const caddy = record.caddy
  if (!caddy || typeof caddy !== "object" || Array.isArray(caddy)) return input
  const caddyRecord = caddy as Record<string, unknown>
  if (caddyRecord.networkVisibility !== undefined) return input
  return { ...record, caddy: { ...caddyRecord, networkVisibility: "private" } }
}

function projectInputOwner(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const owner = (input as Record<string, unknown>).owner
  if (typeof owner !== "string") return undefined
  const normalizedOwner = owner.trim()
  return normalizedOwner === "" ? undefined : normalizedOwner
}

function projectCreateNeedsDefaultDomain(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  if (record.schemaVersion === 2) {
    if (!Array.isArray(record.services)) return false
    return record.services.some((service) => {
      if (!service || typeof service !== "object" || Array.isArray(service)) return false
      const caddy = (service as Record<string, unknown>).caddy
      return (
        caddy !== null &&
        typeof caddy === "object" &&
        !Array.isArray(caddy) &&
        !Array.isArray((caddy as Record<string, unknown>).domains)
      )
    })
  }
  const caddy = record.caddy
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
  afterPersistence?: (project: Project) => void,
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

  const visibilityAppliedInput = projectCreateVisibilityDefaultApply(input, owner)
  const tailscaleR = projectTailscalePrivateRoutesValidate(visibilityAppliedInput, owner, op)
  if (!tailscaleR.success) return tailscaleR

  const projectR = projectCanonicalNormalize(visibilityAppliedInput, {
    projects: snapshotR.data.projects,
    portRange: options.portRange,
    defaultUserDomains: options.defaultUserDomains,
    defaultUserDomain: defaultDomainR.data,
  })
  if (!projectR.success) return projectR

  // Post-normalize pass: domain-less inputs receive their default domain
  // inside normalize, so the pre-normalize check above cannot see injected
  // domains. Re-run on the canonical project to close that bypass.
  const tailscaleNormalizedR = projectTailscalePrivateRoutesValidate(projectR.data, owner, op)
  if (!tailscaleNormalizedR.success) return tailscaleNormalizedR

  const repositoryOptions = { actor: actorR.data.username, expectedRevision: expectedRevisionR.data }
  const mutationR = await options.repository.create(projectR.data, repositoryOptions)
  if (!mutationR.success) return mutationR
  try {
    afterPersistence?.(projectR.data)
  } catch {
    // Background integrations must not turn a successful persistence into a failed creation.
  }
  return mutationR
}
