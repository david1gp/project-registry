import { createResult, type Result } from "#result"
import type { ProjectCanonicalNormalizeOptions } from "./ProjectCanonicalNormalizeOptions.js"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"
import { projectCollisions } from "./projectCollisions.js"
import { projectDomainIsCloudflarePages } from "./projectDomainIsCloudflarePages.js"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectNormalize } from "./projectNormalize.js"
import { projectPortNext } from "./projectPortNext.js"

function canonicalInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = { ...(input as Record<string, unknown>) }
  delete record.expectedRevision
  return record
}

function canonicalServiceIsActiveLocal(service: Record<string, unknown>): boolean {
  const caddy = service.caddy
  if (!caddy || typeof caddy !== "object" || Array.isArray(caddy)) return false
  if (service.ownership === "external") return false
  const caddyRecord = caddy as Record<string, unknown>
  if (caddyRecord.disabled || !Array.isArray(caddyRecord.domains)) return false
  return caddyRecord.domains.some(
    (domain) => typeof domain === "string" && !projectDomainIsCloudflarePages(projectDomainNormalize(domain)),
  )
}

function canonicalExternalPortlessNormalize(
  input: unknown,
  options: ProjectCanonicalNormalizeOptions,
): Result<unknown> {
  const record = canonicalInput(input)
  if (!record || typeof record !== "object" || Array.isArray(record)) return createResult(record)
  const services = (record as Record<string, unknown>).services
  if (!Array.isArray(services)) return createResult(record)

  const allocatePortServiceIds = new Set(options.allocatePortServiceIds ?? [])
  const portless = services.some((service) => {
    if (!service || typeof service !== "object" || Array.isArray(service)) return false
    const serviceRecord = service as Record<string, unknown>
    const caddy = serviceRecord.caddy
    return (
      (serviceRecord.ownership === "external" || allocatePortServiceIds.has(String(serviceRecord.id))) &&
      caddy !== null &&
      typeof caddy === "object" &&
      !Array.isArray(caddy) &&
      (caddy as Record<string, unknown>).port === undefined
    )
  })
  if (!portless) return createResult(record)

  const reserveSiblingPorts = allocatePortServiceIds.size > 0
  const reservedPorts: number[] = []
  if (reserveSiblingPorts) {
    for (const service of services) {
      if (!service || typeof service !== "object" || Array.isArray(service)) continue
      const serviceRecord = service as Record<string, unknown>
      if (!canonicalServiceIsActiveLocal(serviceRecord)) continue
      const caddy = serviceRecord.caddy as Record<string, unknown>
      const port = caddy.port
      if (Number.isInteger(port)) reservedPorts.push(port as number)
    }
  }

  const servicesWithPorts = [...services]
  for (let index = 0; index < servicesWithPorts.length; index += 1) {
    const service = servicesWithPorts[index]
    if (!service || typeof service !== "object" || Array.isArray(service)) continue
    const serviceRecord = service as Record<string, unknown>
    const caddy = serviceRecord.caddy
    const shouldAllocate =
      serviceRecord.ownership === "external" || allocatePortServiceIds.has(String(serviceRecord.id))
    if (
      !shouldAllocate ||
      caddy === null ||
      typeof caddy !== "object" ||
      Array.isArray(caddy) ||
      (caddy as Record<string, unknown>).port !== undefined
    )
      continue

    const portR = projectPortNext(
      options.projects ?? [],
      options.portRange,
      options.excludeKey,
      reserveSiblingPorts ? reservedPorts : [],
    )
    if (!portR.success) return portR
    servicesWithPorts[index] = { ...serviceRecord, caddy: { ...(caddy as Record<string, unknown>), port: portR.data } }
    if (reserveSiblingPorts && canonicalServiceIsActiveLocal(serviceRecord)) reservedPorts.push(portR.data)
  }
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
