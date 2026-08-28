import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"

export type UserDefaultDomainMutation = {
  action: "set" | "unset"
  owner: string
  domain: string | null
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
