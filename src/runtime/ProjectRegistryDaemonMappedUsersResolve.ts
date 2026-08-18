import type { Result } from "#result"
import type { ProjectRegistryDaemonMappedUser } from "./ProjectRegistryDaemonMappedUser.js"

export type ProjectRegistryDaemonMappedUsersResolve = () =>
  | Promise<Result<readonly ProjectRegistryDaemonMappedUser[]>>
  | Result<readonly ProjectRegistryDaemonMappedUser[]>
