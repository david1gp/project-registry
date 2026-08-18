import { createResult, createResultError, type Result } from "#result"
import type { Role } from "./Role.js"

const rolePrecedence: readonly Role[] = ["superadmin", "admin", "own"]

function roleIsKnown(role: unknown): role is Role {
  return role === "own" || role === "admin" || role === "superadmin"
}

export function roleResolve(roles: unknown): Result<Role> {
  const op = "roleResolve"
  if (!Array.isArray(roles) || roles.length > 32) {
    return createResultError(op, "current roles are invalid")
  }
  for (const role of roles) {
    if (!roleIsKnown(role)) return createResultError(op, "current roles are invalid")
  }
  for (const role of rolePrecedence) {
    if (roles.includes(role)) return createResult(role)
  }
  return createResultError(op, "no current Project Registry role")
}
