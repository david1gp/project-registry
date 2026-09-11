import type { ProjectKey } from "../project/projectKey.js"

export type ProjectRepositoryServiceGrouping = {
  source: ProjectKey
  parent: ProjectKey
  serviceId?: string
}
