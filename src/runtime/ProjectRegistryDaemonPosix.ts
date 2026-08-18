import type { PromiseResult } from "#result"
import type { ProjectRegistryDaemonMappedUser } from "./ProjectRegistryDaemonMappedUser.js"

export type ProjectRegistryDaemonPosix = {
  isRoot(): boolean | Promise<boolean>
  userResolve(username: string): PromiseResult<ProjectRegistryDaemonMappedUser>
}
