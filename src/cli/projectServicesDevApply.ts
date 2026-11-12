import { createResult, createResultError, type Result } from "#result"
import type { ProjectService } from "../project/projectServiceSchema.js"

/**
 * Set or clear one service's `dev.command` override, keeping siblings
 * untouched. No change requested returns the services as-is; the daemon
 * validates the argv string again on write.
 */
export function projectServicesDevApply(
  services: readonly ProjectService[],
  serviceId: string,
  devCommand?: string,
  clearDevCommand?: boolean,
): Result<ProjectService[]> {
  const op = "projectServicesDevApply"
  if (devCommand === undefined && clearDevCommand !== true) return createResult([...services])
  if (!services.some((service) => service.id === serviceId)) {
    return createResultError(op, `Service ${serviceId} does not exist; add it with --domain first.`)
  }
  return createResult(
    services.map((service) => {
      if (service.id !== serviceId) return service
      if (clearDevCommand === true) {
        const { dev: _dev, ...rest } = service
        return rest
      }
      return { ...service, dev: { command: devCommand as string } }
    }),
  )
}
