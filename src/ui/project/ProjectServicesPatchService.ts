import type { ProjectServicesService } from "./projectServicesSchema.js"

/** A submitted sibling may leave its Caddy port for the server to allocate. */
export type ProjectServicesPatchService = Omit<ProjectServicesService, "caddy"> & {
  caddy: (Omit<NonNullable<ProjectServicesService["caddy"]>, "port"> & { port?: number }) | null
}
