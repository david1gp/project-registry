import type { ProjectCanonical } from "./projectCanonicalSchema.js"
import type { Project as ProjectLegacy } from "./projectSchema.js"

export type Project = Omit<ProjectLegacy, "schemaVersion" | "services" | "caddy"> & {
  schemaVersion: ProjectLegacy["schemaVersion"] | ProjectCanonical["schemaVersion"]
  services: ProjectLegacy["services"] | ProjectCanonical["services"]
  caddy?: ProjectLegacy["caddy"]
}
