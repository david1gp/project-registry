import type { ProjectServiceManaged } from "../project/projectServiceManagedSchema.js"

/** One registry row service that declares `service: {…}`, flattened for reconcile and the svc API. */
export type ManagedServiceEntry = {
  owner: string
  project: string
  serviceId: string
  unit: string
  port: number
  domains: readonly string[]
  managed: ProjectServiceManaged
}
