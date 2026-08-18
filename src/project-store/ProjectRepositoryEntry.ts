import type { Project } from "../project/Project.js"
import type { ProjectRepositoryRevision } from "./ProjectRepositoryRevision.js"

export type ProjectRepositoryEntry = {
  project: Project
  revision: ProjectRepositoryRevision
}
