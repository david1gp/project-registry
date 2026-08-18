import { createResult, createResultError, type Result } from "#result"
import type { Actor } from "./Actor.js"
import { projectAuthorize } from "./projectAuthorize.js"
import type { Role } from "./Role.js"

export function serviceAuthorize(actor: Actor, owner: string, ownerRole: Role | undefined): Result<void> {
  const op = "serviceAuthorize"
  const authorization = projectAuthorize(actor, owner, ownerRole)
  if (!authorization.success) return createResultError(op, authorization.errorMessage, authorization.errorData)
  return createResult(undefined)
}
