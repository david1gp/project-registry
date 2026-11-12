import { createResult, createResultErrorCode, type Result } from "#result"
import type { Actor } from "../access/Actor.js"

/**
 * `svc` verbs are allowed for every configured operator on every managed
 * service, independent of row ownership (projects are shared under
 * /projects). Socket identity is kernel-derived, never from headers.
 */
export function managedServiceAuthorize(actor: Actor, allowedUsers: readonly string[]): Result<void> {
  const op = "managedServiceAuthorize"
  if (!allowedUsers.includes(actor.username)) {
    return createResultErrorCode(op, "Managed services are not available to this user.", "services.forbidden")
  }
  return createResult(undefined)
}
