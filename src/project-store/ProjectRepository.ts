import type { GitStoreCommitInfo } from "#git-store"
import type { PromiseResult } from "#result"
import type { ProjectKey } from "../project/projectKey.js"
import type { ProjectRepositoryEntry } from "./ProjectRepositoryEntry.js"
import type { ProjectRepositoryMutation } from "./ProjectRepositoryMutation.js"
import type { ProjectRepositoryMutationOptions } from "./ProjectRepositoryMutationOptions.js"
import type { ProjectRepositoryReadiness } from "./ProjectRepositoryReadiness.js"
import type { ProjectRepositorySnapshot } from "./ProjectRepositorySnapshot.js"

export interface ProjectRepository {
  read(): PromiseResult<ProjectRepositorySnapshot>
  get(key: ProjectKey): PromiseResult<ProjectRepositoryEntry>
  create(project: unknown, options: ProjectRepositoryMutationOptions): PromiseResult<ProjectRepositoryMutation>
  edit(
    key: ProjectKey,
    project: unknown,
    options: ProjectRepositoryMutationOptions,
  ): PromiseResult<ProjectRepositoryMutation>
  delete(key: ProjectKey, options: ProjectRepositoryMutationOptions): PromiseResult<ProjectRepositoryMutation>
  history(key?: ProjectKey, limit?: number): PromiseResult<GitStoreCommitInfo[]>
  readiness(): PromiseResult<ProjectRepositoryReadiness>
  recover(): PromiseResult<ProjectRepositoryReadiness>
}
