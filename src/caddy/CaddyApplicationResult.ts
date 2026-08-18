import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"

export type CaddyApplicationResult = {
  revision: ProjectRepositoryRevision
  changed: boolean
  applied: boolean
  attempts: number
}
