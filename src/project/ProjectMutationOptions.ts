import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"

export type ProjectMutationOptions = {
  expectedRevision: ProjectRepositoryRevision
}
