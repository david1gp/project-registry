import { createResultErrorCode, type PromiseResult } from "#result"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { Project } from "./Project.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import { projectCanonicalNormalize } from "./projectCanonicalNormalize.js"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"
import { projectCanonicalToLegacy } from "./projectCanonicalToLegacy.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
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
    if (key === "labels") {
      merged[key] = value
      continue
    }

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

function projectEditCanonicalPatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(input)) {
    if (key !== "expectedRevision") patch[key] = value
  }
  return patch
}

function projectEditCanonicalServiceOwnershipPreserve(
  existing: ProjectCanonical,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(patch.services)) return patch
  const existingServices = new Map(existing.services.map((service) => [service.id, service]))
  patch.services = patch.services.map((service) => {
    if (service === null || typeof service !== "object" || Array.isArray(service)) return service
    const serviceRecord = service as Record<string, unknown>
    if (Object.hasOwn(serviceRecord, "ownership") || typeof serviceRecord.id !== "string") return service
    const existingService = existingServices.get(serviceRecord.id)
    return existingService === undefined ? service : { ...serviceRecord, ownership: existingService.ownership }
  })
  return patch
}

function projectEditCanonicalInput(existing: ProjectCanonical, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const rawPatch = input as Record<string, unknown>
  const patch = projectEditCanonicalServiceOwnershipPreserve(existing, projectEditCanonicalPatch(rawPatch))
  const services = patch.services
  const isCanonicalPatch =
    patch.schemaVersion === 2 ||
    (Array.isArray(services) &&
      services.every((service) => service && typeof service === "object" && !Array.isArray(service)))
  if (isCanonicalPatch) return projectEditRecordMerge(existing as unknown as Record<string, unknown>, patch)

  const legacyR = projectCanonicalToLegacy(existing)
  if (!legacyR.success) return patch
  const mergedLegacy = projectEditRecordMerge(legacyR.data as unknown as Record<string, unknown>, patch)
  const migrated = projectMigrate(mergedLegacy)
  if (!migrated.success) return mergedLegacy

  const defaultService = migrated.data.services.find((service) => service.id === "default")
  const selectedService = existing.services.find((service) => service.id === "default") ?? existing.services[0]
  const servicesWithoutSelected =
    selectedService === undefined
      ? existing.services
      : existing.services.filter((service) => service.id !== selectedService.id)
  const replacement =
    defaultService === undefined || selectedService === undefined
      ? defaultService
      : { ...defaultService, id: selectedService.id }
  return {
    ...migrated.data,
    services: replacement === undefined ? servicesWithoutSelected : [...servicesWithoutSelected, replacement],
  }
}

export async function projectEdit(
  options: ProjectUseCaseOptions,
  key: ProjectKey,
  input: unknown,
  mutationOptions: ProjectMutationOptions,
  afterPersistence?: (previous: Project, project: Project) => void,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectEdit"
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR

  const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, key.owner)
  if (!authorizationR.success) return authorizationR

  if (projectInputIdentityMatches(input, key) === false) {
    return createResultErrorCode(op, "project owner and name are immutable", "request.invalid")
  }

  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR
  const existing = snapshotR.data.projects.find((project) => projectKeyEqual(project, key))
  if (!existing) return createResultErrorCode(op, "project not found", "projects.not-found")

  const existingCanonicalR = projectMigrate(existing)
  if (!existingCanonicalR.success) return existingCanonicalR

  const projectR = projectCanonicalNormalize(projectEditCanonicalInput(existingCanonicalR.data, input), {
    projects: snapshotR.data.projects,
    portRange: options.portRange,
    excludeKey: key,
    excludeProject: existingCanonicalR.data,
  })
  if (!projectR.success) return projectR
  if (!projectKeyEqual(projectR.data, key))
    return createResultErrorCode(op, "project owner and name are immutable", "request.invalid")

  const expectedRevisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, op)
  if (!expectedRevisionR.success) return expectedRevisionR

  const repositoryOptions = { actor: actorR.data.username, expectedRevision: expectedRevisionR.data }
  const mutationR = await options.repository.edit(key, projectR.data, repositoryOptions)
  if (!mutationR.success) return mutationR
  if (mutationR.data.changed) {
    try {
      afterPersistence?.(existing, projectR.data)
    } catch {
      // Background integrations must not turn a successful persistence into a failed edit.
    }
  }
  return mutationR
}
