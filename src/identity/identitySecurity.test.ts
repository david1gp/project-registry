import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { Actor } from "../access/Actor.js"
import type { IdentityDirectory } from "./IdentityDirectory.js"
import { preferredUsernameMap } from "./preferredUsernameMap.js"
import { userRoleResolve } from "./userRoleResolve.js"
import { visibleUserDirectoryList } from "./visibleUserDirectoryList.js"

const actor: Actor = { subject: "actor", username: "alice", role: "admin" }

function directory(roles: Record<string, readonly unknown[]>): IdentityDirectory {
  return {
    async usersList() {
      return createResult([
        { subject: "own-subject", preferredUsername: "alice" },
        { subject: "admin-subject", preferredUsername: "bob" },
        { subject: "superadmin-subject", preferredUsername: "root" },
      ])
    },
    async userRolesList(subject) {
      return createResult(roles[subject] ?? [])
    },
    async userPreferredUsernameResolve(subject) {
      return createResult(subject === "actor" ? "alice" : subject === "own-subject" ? "alice" : "bob")
    },
  }
}

describe("identity boundaries", () => {
  test("maps preferred_username without normalization and requires an existing POSIX user", async () => {
    const users = { usernameExists: async (username: string) => createResult(username === "alice") }
    expect((await preferredUsernameMap("alice", users)).success).toBe(true)
    expect((await preferredUsernameMap(" Alice ", users)).success).toBe(false)
    expect((await preferredUsernameMap("bob", users)).success).toBe(false)
    expect(
      (await preferredUsernameMap("alice", { usernameExists: async () => createResult("true" as never) })).success,
    ).toBe(false)
  })

  test("resolves current roles with precedence and fails closed", async () => {
    const current = directory({ actor: ["own", "superadmin", "admin"] })
    const roleR = await userRoleResolve("actor", "access-token", current)
    expect(roleR.success).toBe(true)
    if (!roleR.success) return
    expect(roleR.data).toBe("superadmin")
    expect((await userRoleResolve("actor", "access-token", directory({ actor: [] }))).success).toBe(false)
    expect((await userRoleResolve("actor", "access-token", directory({ actor: ["operator"] }))).success).toBe(false)
  })

  test("lists only currently visible mapped users", async () => {
    const users = {
      usernameExists: async (username: string) => createResult(username !== "root"),
    }
    const current = directory({
      "own-subject": ["own"],
      "admin-subject": ["admin"],
      "superadmin-subject": ["superadmin"],
    })
    const visibleR = await visibleUserDirectoryList(actor, {
      accessToken: "access-token",
      identityDirectory: current,
      posixUsers: users,
    })
    expect(visibleR.success).toBe(false)
    const visibleUsersR = await visibleUserDirectoryList(
      { ...actor, role: "admin" },
      {
        accessToken: "access-token",
        identityDirectory: directory({
          "own-subject": ["own"],
          "admin-subject": ["admin"],
          "superadmin-subject": ["superadmin"],
        }),
        posixUsers: { usernameExists: async () => createResult(true) },
      },
    )
    expect(visibleUsersR.success).toBe(true)
    if (!visibleUsersR.success) return
    expect(visibleUsersR.data.map((user) => user.username)).toEqual(["alice", "bob"])
    const ownR = await visibleUserDirectoryList(
      { ...actor, role: "own" },
      {
        accessToken: "access-token",
        identityDirectory: current,
        posixUsers: users,
      },
    )
    expect(ownR).toEqual({ success: true, data: [] })
  })

  test("bounds directory waits and visible-user counts", async () => {
    const neverDirectory: IdentityDirectory = {
      async usersList() {
        return await new Promise<never>(() => undefined)
      },
      async userRolesList() {
        return await new Promise<never>(() => undefined)
      },
      async userPreferredUsernameResolve() {
        return createResult("alice")
      },
    }
    expect((await userRoleResolve("actor", "access-token", neverDirectory, { timeoutMs: 5 })).success).toBe(false)

    const tooManyUsers: IdentityDirectory = {
      async usersList() {
        return createResult(
          Array.from({ length: 1_001 }, (_, index) => ({
            subject: `subject-${index}`,
            preferredUsername: `user-${index}`,
          })),
        )
      },
      async userRolesList() {
        return createResult(["own"])
      },
      async userPreferredUsernameResolve() {
        return createResult("alice")
      },
    }
    const tooManyR = await visibleUserDirectoryList(actor, {
      accessToken: "access-token",
      identityDirectory: tooManyUsers,
      posixUsers: { usernameExists: async () => createResult(true) },
    })
    expect(tooManyR.success).toBe(false)
  })
})
