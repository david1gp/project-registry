import type { PromiseResult } from "#result"
import type { Actor } from "../access/Actor.js"
import type { Project } from "../project/Project.js"

export type CaddyProjectListAccess = (
  actor: Actor,
) => PromiseResult<readonly Project[] | { projects: readonly Project[] }>
