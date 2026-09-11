import type { ProjectKey } from "../project/projectKey.js"
import type { ProjectRepositoryRevision } from "./ProjectRepositoryRevision.js"

export type ProjectRepositoryMigration = {
  changed: boolean
  canonicalized: number
  grouped: Array<{
    parent: ProjectKey
    serviceId: string
    source: ProjectKey
  }>
  removed: ProjectKey[]
  revision: ProjectRepositoryRevision
  dryRun: boolean
  localCommit: {
    status: "committed" | "unchanged"
    revision: ProjectRepositoryRevision
  }
  push: {
    requested: boolean
    status: "not-requested" | "pushed" | "failed"
    errorMessage?: string
  }
}
