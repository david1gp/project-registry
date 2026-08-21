import { describe, expect, test } from "bun:test"
import { createResult, createResultError } from "#result"
import type { ProjectRegistryDaemonPosix } from "../runtime/ProjectRegistryDaemonPosix.js"
import { posixUserDirectoryCreate } from "./posixUserDirectoryCreate.js"

function userResolveResult(username: string) {
  return createResult({ username, uid: 1000, gid: 1000 })
}

describe("posixUserDirectoryCreate", () => {
  test("maps an exact runtime POSIX user match to true", async () => {
    const usernames: string[] = []
    const posix: ProjectRegistryDaemonPosix = {
      isRoot: () => false,
      userResolve: async (username) => {
        usernames.push(username)
        return userResolveResult(username)
      },
    }

    expect(await posixUserDirectoryCreate(posix).usernameExists("alice")).toEqual(createResult(true))
    expect(usernames).toEqual(["alice"])
  })

  test("rejects unsafe usernames before lookup", async () => {
    let lookups = 0
    const posix: ProjectRegistryDaemonPosix = {
      isRoot: () => false,
      userResolve: async () => {
        lookups += 1
        return userResolveResult("alice")
      },
    }
    const users = posixUserDirectoryCreate(posix)
    const unsafe = ["", " alice", "alice ", "alice:root", "alice\nroot", "alice/root", "älice", "a".repeat(256)]

    for (const username of unsafe) {
      expect(await users.usernameExists(username)).toEqual(createResult(false))
    }
    expect(lookups).toBe(0)
  })

  test("fails closed for missing, mismatched, malformed, or unavailable users", async () => {
    const cases: ProjectRegistryDaemonPosix[] = [
      { isRoot: () => false, userResolve: async () => createResultError("userResolve", "missing") },
      { isRoot: () => false, userResolve: async () => userResolveResult("bob") },
      { isRoot: () => false, userResolve: async () => ({ success: true, data: true }) as never },
      { isRoot: () => false, userResolve: async () => Promise.reject(new Error("passwd unavailable")) },
    ]

    for (const posix of cases) {
      expect(await posixUserDirectoryCreate(posix).usernameExists("alice")).toEqual(createResult(false))
    }
  })
})
