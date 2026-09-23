import type { ProjectRepositoryMutationOptions } from "./ProjectRepositoryMutationOptions.js"
import type { ProjectKey } from "../project/projectKey.js"

export type ProjectRepositoryTransactionOptions = ProjectRepositoryMutationOptions & {
  writes: unknown[]
  removals: ProjectKey[]
}
