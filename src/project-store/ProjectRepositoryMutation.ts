import type { ProjectKey } from "../project/projectKey.js"
import type { ProjectRepositoryRevision } from "./ProjectRepositoryRevision.js"

export type ProjectRepositoryMutation = {
  action: "create" | "edit" | "delete"
  key: ProjectKey
  changed: boolean
  revision: ProjectRepositoryRevision
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
