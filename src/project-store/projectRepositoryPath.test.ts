import { describe, expect, test } from "bun:test"
import { projectRepositoryPath } from "./projectRepositoryPath.js"

describe("projectRepositoryPath", () => {
  test("builds the owner/name JSON path", () => {
    const result = projectRepositoryPath({ owner: "alice", name: "catalog" })

    expect(result).toEqual({ success: true, data: "projects/alice/catalog.json" })
  })

  test("rejects path traversal and unsafe project names", () => {
    expect(projectRepositoryPath({ owner: "../alice", name: "catalog" }).success).toBe(false)
    expect(projectRepositoryPath({ owner: "alice/other", name: "catalog" }).success).toBe(false)
    expect(projectRepositoryPath({ owner: "alice\\other", name: "catalog" }).success).toBe(false)
    expect(projectRepositoryPath({ owner: "alice", name: "../catalog" }).success).toBe(false)
    expect(projectRepositoryPath({ owner: "alice", name: "catalog/other" }).success).toBe(false)
    expect(projectRepositoryPath({ owner: ".git", name: "catalog" }).success).toBe(false)
    expect(projectRepositoryPath({ owner: "alice", name: ".git" }).success).toBe(false)
  })
})
