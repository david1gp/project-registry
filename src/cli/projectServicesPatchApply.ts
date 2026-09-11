import { createResult, createResultError, type Result } from "#result"
import type { ProjectServiceOwnership } from "../project/projectServiceOwnershipSchema.js"
import type { ProjectService } from "../project/projectServiceSchema.js"
import type { ProjectRegistryCliCaddyOptions } from "./ProjectRegistryCliCaddyOptions.js"

/**
 * Apply Caddy and ownership option overrides to one service of a canonical project,
 * keeping every sibling service untouched so a project can hold multiple services.
 */
export function projectServicesPatchApply(
  services: readonly ProjectService[],
  serviceId: string,
  caddy: ProjectRegistryCliCaddyOptions,
  ownership?: ProjectServiceOwnership,
): Result<ProjectService[]> {
  const op = "projectServicesPatchApply"
  const existing = services.find((service) => service.id === serviceId)

  if (existing === undefined) {
    if (caddy.port === undefined || caddy.domains === undefined || caddy.domains.length === 0) {
      return createResultError(
        op,
        `Service ${serviceId} does not exist yet; provide --port and at least one --domain to add it.`,
      )
    }
    const added = {
      id: serviceId,
      units: [],
      caddy: { ...caddy, domains: [...caddy.domains] },
      ownership: ownership ?? "registry",
    }
    return createResult([...services, added as unknown as ProjectService])
  }

  if (existing.caddy === null && ownership === undefined && (caddy.port === undefined || caddy.domains === undefined)) {
    return createResultError(op, `Service ${serviceId} has no Caddy configuration; provide --port and --domain.`)
  }

  if (existing.caddy === null && ownership !== undefined && caddy.port === undefined && caddy.domains === undefined) {
    return createResult(services.map((service) => (service.id === serviceId ? { ...service, ownership } : service)))
  }

  const merged = { ...(existing.caddy ?? {}), ...caddy } as ProjectService["caddy"]
  return createResult(
    services.map((service) =>
      service.id === serviceId
        ? { ...service, caddy: merged, ownership: ownership ?? service.ownership ?? "registry" }
        : service,
    ),
  )
}
