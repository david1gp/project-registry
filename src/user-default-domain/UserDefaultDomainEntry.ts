import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"

export type UserDefaultDomainEntry = {
  owner: string
  domain: string | null | undefined
  revision: ProjectRepositoryRevision
}
