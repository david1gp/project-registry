import { createResult, createResultError, type Result } from "#result"
import type { Actor } from "./Actor.js"
import type { Role } from "./Role.js"
import type { SuperadminOperation } from "./SuperadminOperation.js"

const superadminOperations: readonly SuperadminOperation[] = ["caddy-config", "caddy-status", "caddy-regenerate"]

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

export function superadminAuthorize(actor: Actor, operation: SuperadminOperation): Result<void> {
  const op = "superadminAuthorize"
  if (!superadminOperations.includes(operation)) return createResultError(op, "superadmin operation is invalid")
  if (!actorIsValid(actor)) return createResultError(op, "actor mapping or current role is unavailable")
  if (actor.role !== "superadmin") return createResultError(op, `operation requires superadmin: ${operation}`)
  return createResult(undefined)
}
