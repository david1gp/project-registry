import type { PromiseResult } from "#result"
import type { Actor } from "./Actor.js"
import type { Role } from "./Role.js"

export interface ProjectAccess {
  actorResolve(): PromiseResult<Actor>
  ownerRoleResolve(owner: string): PromiseResult<Role | undefined>
}
