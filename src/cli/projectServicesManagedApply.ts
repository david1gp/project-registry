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
 * daemon's deep merge removes them instead of restoring stored values.
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
    return createResultError(op, `Service ${serviceId} does not exist; add it with --domain first.`)
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
