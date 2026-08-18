import type { ProjectRepositoryRevision } from "./ProjectRepositoryRevision.js"

export type ProjectRepositoryMutationOptions = {
  actor: string
  expectedRevision: ProjectRepositoryRevision
}
