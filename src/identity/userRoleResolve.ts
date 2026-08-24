import { createResult, createResultError, type PromiseResult } from "#result"
import type { Role } from "../access/Role.js"
import { roleResolve } from "../access/roleResolve.js"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { IdentityDirectory } from "./IdentityDirectory.js"

const roleHint = "Ask an administrator to verify that your account has a Project Registry role, then retry."

function roleError(op: string) {
  return { ...createResultError(op, "current role is unavailable"), hint: roleHint }
}

export async function userRoleResolve(
  subject: string,
  accessToken: string,
  directory: IdentityDirectory,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): PromiseResult<Role> {
  const op = "userRoleResolve"
  if (
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > 256 ||
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > 8192
  ) {
    return roleError(op)
  }
  try {
    const rolesR = await promiseBoundedRace(
      Promise.resolve().then(() => directory.userRolesList(subject, accessToken)),
      options,
    )
    if (
      rolesR.success !== true ||
      rolesR.data.success !== true ||
      !Array.isArray(rolesR.data.data) ||
      rolesR.data.data.length > 32
    ) {
      return roleError(op)
    }
    const roleR = roleResolve(rolesR.data.data)
    if (!roleR.success) return roleError(op)
    return createResult(roleR.data)
  } catch {
    return roleError(op)
  }
}
