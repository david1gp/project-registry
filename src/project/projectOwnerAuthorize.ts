import { createResult, type PromiseResult } from "#result"
import type { Actor } from "../access/Actor.js"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import { projectAuthorize } from "../access/projectAuthorize.js"

export async function projectOwnerAuthorize(access: ProjectAccess, actor: Actor, owner: string): PromiseResult<void> {
  const ownerRoleR = await access.ownerRoleResolve(owner)
  if (!ownerRoleR.success) return ownerRoleR

  const authorizationR = projectAuthorize(actor, owner, ownerRoleR.data)
  if (!authorizationR.success) return authorizationR
  return createResult(undefined)
}
