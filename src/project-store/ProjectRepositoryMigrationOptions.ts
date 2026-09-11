import type { ProjectRepositoryRevision } from "./ProjectRepositoryRevision.js"
import type { ProjectRepositoryServiceGrouping } from "./ProjectRepositoryServiceGrouping.js"

export type ProjectRepositoryMigrationOptions = {
  actor: string
  expectedRevision?: ProjectRepositoryRevision
  groupings?: readonly ProjectRepositoryServiceGrouping[]
  dryRun?: boolean
}
