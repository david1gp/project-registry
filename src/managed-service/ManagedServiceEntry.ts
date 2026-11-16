import type { ProjectServiceManaged } from "../project/projectServiceManagedSchema.js"

/**
 * One registry row service that declares `service: {…}`, flattened for
 * reconcile and the svc API. Background workers have no Caddy route
 * (`caddy: null`): no port and no domains.
 */
export type ManagedServiceEntry = {
  owner: string
  project: string
  serviceId: string
  unit: string
  port?: number
  domains: readonly string[]
  managed: ProjectServiceManaged
}
