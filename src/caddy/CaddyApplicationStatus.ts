import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"

export type CaddyApplicationStatus = {
  desiredRevision?: ProjectRepositoryRevision
  appliedRevision?: ProjectRepositoryRevision
  pendingRevision?: ProjectRepositoryRevision
  pending: boolean
  lastAttempt?: number
  lastSuccess?: number
  error?: string
}
