import { createResult, createResultErrorCode, type Result } from "#result"
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
  if (!actorIsValid(actor))
    return createResultErrorCode(op, "actor mapping or current role is unavailable", "projects.forbidden")
  if (typeof owner !== "string" || owner.length === 0) {
    return {
      ...createResultErrorCode(op, "project owner mapping is unavailable", "projects.forbidden"),
      errorData: owner,
    }
  }
  if (ownerRole !== undefined && !roleIsKnown(ownerRole)) {
    return { ...createResultErrorCode(op, "project owner role is invalid", "projects.forbidden"), errorData: owner }
  }
  if (ownerRole === undefined && actor.role !== "superadmin") {
    return {
      ...createResultErrorCode(op, "project owner current role is unavailable", "projects.forbidden"),
      errorData: owner,
    }
  }
  if (actor.role === "superadmin") return createResult(undefined)
  if (actor.role === "admin" && (ownerRole === "own" || ownerRole === "admin")) return createResult(undefined)
  if (actor.role === "own" && ownerRole === "own" && actor.username === owner) return createResult(undefined)
  return {
    ...createResultErrorCode(op, "actor is not authorized for project owner", "projects.forbidden"),
    errorData: owner,
  }
}
