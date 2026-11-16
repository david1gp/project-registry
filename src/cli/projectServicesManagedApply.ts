import { createResult, createResultError, type Result } from "#result"
import type { ProjectService } from "../project/projectServiceSchema.js"

export type ProjectServicesManagedPatch = {
  command?: string
  clearCommand?: boolean
  envFile?: string
  clearEnvFile?: boolean
  autostart?: boolean
}

/**
 * Apply `--service-command`/`--service-env-file`/`--autostart` edits to one
 * service's managed `service` definition. A first definition needs an
 * explicit `--autostart`/`--no-autostart`; clears travel as `null` so the
 * daemon's deep merge removes them instead of restoring stored values. A
 * service id that does not exist yet is added as a background worker (no
 * Caddy route, so no port or domain); it needs an explicit `--service-command`.
 */
export function projectServicesManagedApply(
  services: readonly ProjectService[],
  serviceId: string,
  patch: ProjectServicesManagedPatch | undefined,
): Result<ProjectService[]> {
  const op = "projectServicesManagedApply"
  if (patch === undefined) return createResult([...services])
  const target = services.find((service) => service.id === serviceId)
  if (target === undefined) {
    if (patch.command === undefined) {
      return createResultError(
        op,
        `Service ${serviceId} does not exist; add it with --domain, or pass --service-command to add a background worker.`,
      )
    }
    if (patch.autostart === undefined) {
      return createResultError(
        op,
        `Service ${serviceId} has no managed definition yet; pass --autostart or --no-autostart.`,
      )
    }
    const managed: Record<string, unknown> = { autostart: patch.autostart, command: patch.command }
    if (patch.envFile !== undefined) managed.envFile = patch.envFile
    const worker = { id: serviceId, units: [], caddy: null, ownership: "registry", service: managed }
    return createResult([...services, worker as unknown as ProjectService])
  }
  const autostart = patch.autostart ?? target.service?.autostart
  if (autostart === undefined) {
    return createResultError(
      op,
      `Service ${serviceId} has no managed definition yet; pass --autostart or --no-autostart.`,
    )
  }
  const managed: Record<string, unknown> = { autostart }
  if (patch.command !== undefined) managed.command = patch.command
  if (patch.clearCommand === true) managed.command = null
  if (patch.envFile !== undefined) managed.envFile = patch.envFile
  if (patch.clearEnvFile === true) managed.envFile = null
  return createResult(
    services.map((service) =>
      service.id === serviceId ? ({ ...service, service: managed } as unknown as ProjectService) : service,
    ),
  )
}
