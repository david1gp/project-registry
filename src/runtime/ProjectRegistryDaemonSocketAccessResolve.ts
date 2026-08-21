import type { PromiseResult } from "#result"
import type { ProjectAccess } from "../access/ProjectAccess.js"

export type ProjectRegistryDaemonSocketAccessResolve = (username: string) => PromiseResult<ProjectAccess>
