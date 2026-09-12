import { createResult, createResultErrorCode, type Result } from "#result"
import type { ProjectCanonicalNormalizeOptions } from "./ProjectCanonicalNormalizeOptions.js"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"
import { projectCollisions } from "./projectCollisions.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectNormalize } from "./projectNormalize.js"
import { projectPortNext } from "./projectPortNext.js"

function canonicalInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = { ...(input as Record<string, unknown>) }
  delete record.expectedRevision
  return record
}

function canonicalExternalPortlessNormalize(
  input: unknown,
  options: ProjectCanonicalNormalizeOptions,
): Result<unknown> {
  const record = canonicalInput(input)
  if (!record || typeof record !== "object" || Array.isArray(record)) return createResult(record)
  const services = (record as Record<string, unknown>).services
  if (!Array.isArray(services)) return createResult(record)

  const portlessExternal = services.some((service) => {
    if (!service || typeof service !== "object" || Array.isArray(service)) return false
    const serviceRecord = service as Record<string, unknown>
    const caddy = serviceRecord.caddy
    return (
      serviceRecord.ownership === "external" &&
      caddy !== null &&
      typeof caddy === "object" &&
      !Array.isArray(caddy) &&
      (caddy as Record<string, unknown>).port === undefined
    )
  })
  if (!portlessExternal) return createResult(record)

  const portR = projectPortNext(options.projects ?? [], options.portRange, options.excludeKey)
  if (!portR.success) return portR
  const servicesWithPorts = services.map((service) => {
    if (!service || typeof service !== "object" || Array.isArray(service)) return service
    const serviceRecord = service as Record<string, unknown>
    const caddy = serviceRecord.caddy
    if (
      serviceRecord.ownership !== "external" ||
      caddy === null ||
      typeof caddy !== "object" ||
      Array.isArray(caddy) ||
      (caddy as Record<string, unknown>).port !== undefined
    )
      return service
    return { ...serviceRecord, caddy: { ...(caddy as Record<string, unknown>), port: portR.data } }
  })
  return createResult({ ...record, services: servicesWithPorts })
}

export function projectCanonicalNormalize(
  input: unknown,
  options: ProjectCanonicalNormalizeOptions = {},
): Result<ProjectCanonical> {
  const op = "projectCanonicalNormalize"
  const record =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  if (record?.schemaVersion === 2) {
    const portlessExternalR = canonicalExternalPortlessNormalize(input, options)
    if (!portlessExternalR.success) return { ...portlessExternalR, op }
    const migrated = projectMigrate(portlessExternalR.data)
    if (!migrated.success) return { ...migrated, op }
    const collisions = projectCollisions(options.projects ?? [], {
      excludeKey: options.excludeKey,
      excludeProject: options.excludeProject,
      replacement: migrated.data,
    })
    if (!collisions.success) return { ...collisions, op }
    return createResult(migrated.data)
  }

  const legacyR = projectNormalize(input, options)
  if (!legacyR.success) return { ...legacyR, op }
  const migrated = projectMigrate(legacyR.data)
  if (!migrated.success) return { ...migrated, op }
  return createResult(migrated.data)
}
