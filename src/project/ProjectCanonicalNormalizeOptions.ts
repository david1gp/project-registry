import type { Project } from "./Project.js"
import type { ProjectNormalizeOptions } from "./projectNormalize.js"

export type ProjectCanonicalNormalizeOptions = Omit<ProjectNormalizeOptions, "projects" | "excludeProject"> & {
  projects?: readonly Project[]
  excludeProject?: Project
}
