import { describe, expect, test } from "bun:test"
import { createResult, createResultError } from "#result"
import type { IdentityDirectory } from "../identity/IdentityDirectory.js"
import type { IdentityDirectoryUser } from "../identity/IdentityDirectoryUser.js"
import { projectAccessCreate } from "./projectAccessCreate.js"
import { projectAuthorize } from "./projectAuthorize.js"
import type { Role } from "./Role.js"

function directoryCreate(
  users: () => readonly IdentityDirectoryUser[],
  roles: () => Record<string, readonly unknown[]>,
): IdentityDirectory {
  return {
    usersList: async () => createResult(users()),
    userRolesList: async (subject) => createResult(roles()[subject] ?? []),
    userPreferredUsernameResolve: async (subject) => {
      const user = users().find((entry) => entry.subject === subject)
      return user === undefined ? createResultError("test", "user removed") : createResult(user.preferredUsername)
    },
  }
}

function accessCreate(
  users: () => readonly IdentityDirectoryUser[],
  roles: () => Record<string, readonly unknown[]>,
  username: string,
  roleToken: string,
) {
  return projectAccessCreate({
    identityDirectory: directoryCreate(users, roles),
    posixUsers: {
      usernameExists: async (value) => createResult(users().some((user) => user.preferredUsername === value)),
    },
    transport: { transport: "unix", username, accessToken: roleToken },
  })
}

describe("projectAccessCreate", () => {
  test("binds Unix actor subject and username and resolves the current role", async () => {
    const users = () => [
      { subject: "alice-subject", preferredUsername: "alice" },
      { subject: "bob-subject", preferredUsername: "bob" },
    ]
    let roles: Record<string, readonly unknown[]> = {
      "alice-subject": ["own"],
      "bob-subject": ["admin", "own"],
    }
    const access = accessCreate(users, () => roles, "alice", "access-token")

    expect(await access.actorResolve()).toEqual({
      success: true,
      data: { subject: "alice-subject", username: "alice", role: "own" },
    })
    expect(await access.ownerRoleResolve("bob")).toEqual({ success: true, data: "admin" })

    roles = { ...roles, "alice-subject": ["superadmin"] }
    expect(await access.actorResolve()).toMatchObject({ success: true, data: { role: "superadmin" } })
  })

  test("matches projectAuthorize for every current actor and owner role", async () => {
    const users = () => [
      { subject: "alice-subject", preferredUsername: "alice" },
      { subject: "bob-subject", preferredUsername: "bob" },
    ]
    const actorRoles: readonly Role[] = ["own", "admin", "superadmin"]
    const ownerRoles: readonly (Role | undefined)[] = ["own", "admin", "superadmin", undefined]

    for (const actorRole of actorRoles) {
      for (const ownerRole of ownerRoles) {
        const currentUsers =
          ownerRole === undefined ? [{ subject: "alice-subject", preferredUsername: "alice" }] : users()
        const roles = {
          "alice-subject": [actorRole],
          ...(ownerRole === undefined ? {} : { "bob-subject": [ownerRole] }),
        }
        const access = accessCreate(
          () => currentUsers,
          () => roles,
          "alice",
          "access-token",
        )
        const actorR = await access.actorResolve()
        expect(actorR.success).toBe(true)
        if (!actorR.success) continue
        const ownerRoleR = await access.ownerRoleResolve("bob")
        expect(ownerRoleR.success).toBe(true)
        if (!ownerRoleR.success) continue
        expect(projectAuthorize(actorR.data, "bob", ownerRoleR.data).success).toBe(
          actorRole === "superadmin" ||
            (actorRole === "admin" && (ownerRole === "own" || ownerRole === "admin")) ||
            (actorRole === "own" && ownerRole === "own" && actorR.data.username === "bob"),
        )
      }
    }
  })

  test("treats removed owner mappings as unresolved and fails closed for non-superadmins", async () => {
    let users: readonly IdentityDirectoryUser[] = [
      { subject: "alice-subject", preferredUsername: "alice" },
      { subject: "bob-subject", preferredUsername: "bob" },
    ]
    const roles = { "alice-subject": ["admin"], "bob-subject": ["own"] }
    const access = accessCreate(
      () => users,
      () => roles,
      "alice",
      "access-token",
    )

    expect(await access.ownerRoleResolve("bob")).toEqual({ success: true, data: "own" })
    users = [{ subject: "alice-subject", preferredUsername: "alice" }]
    const actorR = await access.actorResolve()
    const ownerRoleR = await access.ownerRoleResolve("bob")
    expect(actorR.success && actorR.data.role).toBe("admin")
    expect(ownerRoleR).toEqual({ success: true, data: undefined })
    if (actorR.success && ownerRoleR.success) {
      expect(projectAuthorize(actorR.data, "bob", ownerRoleR.data).success).toBe(false)
    }
    users = []
    expect((await access.actorResolve()).success).toBe(false)
  })

  test("uses sessionActorResolve conventions for browser identity", async () => {
    const now = 1_700_000_000_000
    const tokenReferences = {
      resolve: async () => createResult({ accessToken: "browser-token", expiresAt: now + 60_000 }),
    } as never
    const sessions = {
      resolve: async () =>
        createResult({
          id: "session",
          subject: "alice-subject",
          username: "alice",
          tokenReference: "token-reference",
          createdAt: now - 1_000,
          expiresAt: now + 60_000,
        }),
    } as never
    const users = [
      { subject: "alice-subject", preferredUsername: "alice" },
      { subject: "bob-subject", preferredUsername: "bob" },
    ]
    const roles: Record<string, readonly unknown[]> = {
      "alice-subject": ["admin"],
      "bob-subject": ["own"],
    }
    const access = projectAccessCreate({
      identityDirectory: directoryCreate(
        () => users,
        () => roles,
      ),
      posixUsers: { usernameExists: async () => createResult(true) },
      transport: {
        transport: "browser",
        sessionId: "session",
        sessions,
        tokenReferences,
        clock: () => now,
      },
    })

    expect(await access.actorResolve()).toEqual({
      success: true,
      data: { subject: "alice-subject", username: "alice", role: "admin" },
    })
    expect(await access.ownerRoleResolve("bob")).toEqual({ success: true, data: "own" })
  })
})
