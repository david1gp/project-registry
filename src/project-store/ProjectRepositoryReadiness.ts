import type { ProjectRepositoryRevision } from "./ProjectRepositoryRevision.js"

export type ProjectRepositoryReadiness = {
  ready: boolean
  clean: boolean
  revision: ProjectRepositoryRevision
  reason?: string
}
