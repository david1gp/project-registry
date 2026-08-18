import { describe, expect, test } from "bun:test"
import { projectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"

describe("project key", () => {
  test("uses the immutable owner/name pair", () => {
    const alice = { owner: "alice", name: "catalog" }
    const same = { owner: "alice", name: "catalog" }
    const bob = { owner: "bob", name: "catalog" }

    expect(projectKey(alice)).toBe('["alice","catalog"]')
    expect(projectKeyEqual(alice, same)).toBe(true)
    expect(projectKeyEqual(alice, bob)).toBe(false)
  })

  test("keeps slash-containing owner/name pairs distinct", () => {
    const ownerSlash = { owner: "a/b", name: "c" }
    const nameSlash = { owner: "a", name: "b/c" }

    expect(projectKey(ownerSlash)).not.toBe(projectKey(nameSlash))
  })
})
