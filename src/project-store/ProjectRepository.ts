import type { GitStoreCommitInfo } from "#git-store"
import type { PromiseResult } from "#result"
import type { ProjectKey } from "../project/projectKey.js"
import type { UserDefaultDomainEntry } from "../user-default-domain/UserDefaultDomainEntry.js"
import type { UserDefaultDomainMutation } from "../user-default-domain/UserDefaultDomainMutation.js"
import type { ProjectRepositoryEntry } from "./ProjectRepositoryEntry.js"
import type { ProjectRepositoryMutation } from "./ProjectRepositoryMutation.js"
import type { ProjectRepositoryMutationOptions } from "./ProjectRepositoryMutationOptions.js"
import type { ProjectRepositoryReadiness } from "./ProjectRepositoryReadiness.js"
import type { ProjectRepositorySnapshot } from "./ProjectRepositorySnapshot.js"

export interface ProjectRepository {
  read(): PromiseResult<ProjectRepositorySnapshot>
  get(key: ProjectKey): PromiseResult<ProjectRepositoryEntry>
  getUserDefaultDomain(owner: string): PromiseResult<UserDefaultDomainEntry>
  create(project: unknown, options: ProjectRepositoryMutationOptions): PromiseResult<ProjectRepositoryMutation>
  edit(
    key: ProjectKey,
    project: unknown,
    options: ProjectRepositoryMutationOptions,
  ): PromiseResult<ProjectRepositoryMutation>
  delete(key: ProjectKey, options: ProjectRepositoryMutationOptions): PromiseResult<ProjectRepositoryMutation>
  setUserDefaultDomain(
    owner: string,
    domain: string | null,
    options: ProjectRepositoryMutationOptions,
  ): PromiseResult<UserDefaultDomainMutation>
  history(key?: ProjectKey, limit?: number): PromiseResult<GitStoreCommitInfo[]>
  ownerHistory(owner: string, limit?: number): PromiseResult<GitStoreCommitInfo[]>
  readiness(): PromiseResult<ProjectRepositoryReadiness>
  recover(): PromiseResult<ProjectRepositoryReadiness>
}
