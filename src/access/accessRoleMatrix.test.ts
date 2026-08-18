import { describe, expect, test } from "bun:test"
import type { Result } from "#result"
import type { MappedUser } from "../identity/MappedUser.js"
import type { Actor } from "./Actor.js"
import { projectAuthorize } from "./projectAuthorize.js"
import type { Role } from "./Role.js"
import { roleResolve } from "./roleResolve.js"
import type { SuperadminOperation } from "./SuperadminOperation.js"
import { serviceAuthorize } from "./serviceAuthorize.js"
import { superadminAuthorize } from "./superadminAuthorize.js"
import { visibleUserList } from "./visibleUserList.js"

const actorRoles: readonly Role[] = ["own", "admin", "superadmin"]
const ownerRoles: readonly (Role | undefined)[] = ["own", "admin", "superadmin", undefined]
const superadminOperations: readonly SuperadminOperation[] = ["caddy-config", "caddy-status", "caddy-regenerate"]

function actor(role: Role | undefined): Actor {
  return { subject: "actor-subject", username: "alice", role }
}

function allowed(actorRole: Role, owner: string, ownerRole: Role | undefined): boolean {
  if (actorRole === "superadmin") return true
  if (ownerRole === undefined) return false
  if (actorRole === "admin") return ownerRole === "own" || ownerRole === "admin"
  return ownerRole === "own" && owner === "alice"
}

function resultData<T>(result: Result<T>): T {
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("access role matrix", () => {
  test("resolves every valid role combination using precedence", () => {
    const cases: readonly (readonly [readonly Role[], Role])[] = [
      [["own"], "own"],
      [["admin"], "admin"],
      [["superadmin"], "superadmin"],
      [["own", "admin"], "admin"],
      [["admin", "own"], "admin"],
      [["own", "superadmin"], "superadmin"],
      [["superadmin", "own"], "superadmin"],
      [["admin", "superadmin"], "superadmin"],
      [["superadmin", "admin"], "superadmin"],
      [["own", "admin", "superadmin"], "superadmin"],
      [["superadmin", "own", "admin"], "superadmin"],
    ]

    for (const [roles, expectedRole] of cases) {
      expect(resultData(roleResolve(roles))).toBe(expectedRole)
    }
  })

  test("rejects malformed role collections before applying precedence", () => {
    const malformedRoles: readonly unknown[] = [null, {}, "admin", ["admin", 1], ["superadmin", null], ["operator"], []]

    for (const roles of malformedRoles) {
      expect(roleResolve(roles).success).toBe(false)
    }
  })

  test("applies every actor and owner role combination to project and service authorization", () => {
    for (const actorRole of actorRoles) {
      for (const ownerRole of ownerRoles) {
        for (const owner of ["alice", "bob"]) {
          const expected = allowed(actorRole, owner, ownerRole)
          expect(projectAuthorize(actor(actorRole), owner, ownerRole).success).toBe(expected)
          expect(serviceAuthorize(actor(actorRole), owner, ownerRole).success).toBe(expected)
        }
      }
    }
  })

  test("allows unresolved project owners only to a current superadmin", () => {
    expect(projectAuthorize(actor("own"), "orphan", undefined).success).toBe(false)
    expect(projectAuthorize(actor("admin"), "orphan", undefined).success).toBe(false)
    expect(projectAuthorize(actor("superadmin"), "orphan", undefined).success).toBe(true)
    expect(serviceAuthorize(actor("superadmin"), "orphan", undefined).success).toBe(true)
  })

  test("fails closed when the actor current role is unavailable", () => {
    expect(projectAuthorize(actor(undefined), "alice", "own").success).toBe(false)
    expect(serviceAuthorize(actor(undefined), "alice", "own").success).toBe(false)
    expect(superadminAuthorize(actor(undefined), "caddy-regenerate").success).toBe(false)
  })

  test("allows only superadmins to perform machine-wide operations", () => {
    for (const operation of superadminOperations) {
      expect(superadminAuthorize(actor("own"), operation).success).toBe(false)
      expect(superadminAuthorize(actor("admin"), operation).success).toBe(false)
      expect(superadminAuthorize(actor("superadmin"), operation).success).toBe(true)
    }
  })

  test("rejects operations outside the declared superadmin allowlist", () => {
    const invalidOperation = "project-delete" as unknown as SuperadminOperation
    expect(superadminAuthorize(actor("superadmin"), invalidOperation).success).toBe(false)
  })

  test("filters visible users by the actor's current role", () => {
    const users: readonly MappedUser[] = [
      { subject: "own-subject", username: "own-user", role: "own" },
      { subject: "admin-subject", username: "admin-user", role: "admin" },
      { subject: "superadmin-subject", username: "superadmin-user", role: "superadmin" },
    ]

    expect(resultData(visibleUserList(actor("own"), users))).toEqual([])
    expect(resultData(visibleUserList(actor("admin"), users)).map((user) => user.username)).toEqual([
      "own-user",
      "admin-user",
    ])
    expect(resultData(visibleUserList(actor("superadmin"), users)).map((user) => user.username)).toEqual([
      "own-user",
      "admin-user",
      "superadmin-user",
    ])
  })

  test("fails closed for unavailable or malformed actor roles", () => {
    const malformedActor = { ...actor("admin"), role: "operator" } as unknown as Actor
    expect(visibleUserList(actor(undefined), [])).toMatchObject({ success: false })
    expect(visibleUserList(malformedActor, [])).toMatchObject({ success: false })
    expect(projectAuthorize(malformedActor, "alice", "own").success).toBe(false)
    expect(serviceAuthorize(malformedActor, "alice", "own").success).toBe(false)
    expect(superadminAuthorize(malformedActor, "caddy-status").success).toBe(false)
  })

  test("fails closed for malformed mapped-user roles and mappings", () => {
    const validUser: MappedUser = { subject: "user-subject", username: "user", role: "own" }
    const invalidUsers: readonly (readonly MappedUser[])[] = [
      [{ ...validUser, role: undefined }],
      [{ ...validUser, role: "operator" as unknown as Role }],
      [{ ...validUser, subject: "" }],
      [{ ...validUser, username: "" }],
      [undefined as unknown as MappedUser],
      new Array<MappedUser>(1),
      [validUser, { ...validUser, subject: validUser.subject }],
      [validUser, { ...validUser, username: validUser.username }],
    ]

    for (const users of invalidUsers) {
      expect(visibleUserList(actor("superadmin"), users).success).toBe(false)
    }
  })

  test("fails closed for empty actor and project-owner identity fields", () => {
    const emptyUsername = { ...actor("own"), username: "" }
    const emptySubject = { ...actor("own"), subject: "" }
    expect(visibleUserList(emptyUsername, []).success).toBe(false)
    expect(visibleUserList(emptySubject, []).success).toBe(false)
    expect(superadminAuthorize(emptyUsername, "caddy-status").success).toBe(false)
    expect(projectAuthorize(emptyUsername, "alice", "own").success).toBe(false)
    expect(projectAuthorize(actor("own"), "", "own").success).toBe(false)
    const invalidOwnerRole = "invalid" as unknown as Role
    for (const actorRole of actorRoles) {
      expect(projectAuthorize(actor(actorRole), "alice", invalidOwnerRole).success).toBe(false)
      expect(serviceAuthorize(actor(actorRole), "alice", invalidOwnerRole).success).toBe(false)
    }
  })
})
