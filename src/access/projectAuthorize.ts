import { createResult, createResultError, type Result } from "#result"
import type { Actor } from "./Actor.js"
import type { Role } from "./Role.js"

function roleIsKnown(role: unknown): role is Role {
  return role === "own" || role === "admin" || role === "superadmin"
}

function actorIsValid(actor: Actor): boolean {
  if (typeof actor !== "object" || actor === null) return false
  return (
    typeof actor.username === "string" &&
    actor.username.length > 0 &&
    (actor.subject === null || (typeof actor.subject === "string" && actor.subject.length > 0)) &&
    roleIsKnown(actor.role)
  )
}

export function projectAuthorize(actor: Actor, owner: string, ownerRole: Role | undefined): Result<void> {
  const op = "projectAuthorize"
  if (!actorIsValid(actor)) return createResultError(op, "actor mapping or current role is unavailable")
  if (typeof owner !== "string" || owner.length === 0) {
    return createResultError(op, "project owner mapping is unavailable", owner)
  }
  if (ownerRole !== undefined && !roleIsKnown(ownerRole)) {
    return createResultError(op, "project owner role is invalid", owner)
  }
  if (ownerRole === undefined && actor.role !== "superadmin") {
    return createResultError(op, "project owner current role is unavailable", owner)
  }
  if (actor.role === "superadmin") return createResult(undefined)
  if (actor.role === "admin" && (ownerRole === "own" || ownerRole === "admin")) return createResult(undefined)
  if (actor.role === "own" && ownerRole === "own" && actor.username === owner) return createResult(undefined)
  return createResultError(op, "actor is not authorized for project owner", owner)
}
