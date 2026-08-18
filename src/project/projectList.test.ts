import { describe, expect, test } from "bun:test"
import { projectList } from "./projectList.js"
import { projectNormalize } from "./projectNormalize.js"

function project(input: { owner: string; name: string; type: "own" | "internal" | "customer"; order: number }) {
  const result = projectNormalize(input)
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("projectList", () => {
  test("returns projects in deterministic Software-compatible order", () => {
    const result = projectList([
      project({ owner: "bob", name: "same", type: "own", order: 1 }),
      project({ owner: "alice", name: "same", type: "own", order: 1 }),
      project({ owner: "alice", name: "customer", type: "customer", order: 1 }),
      project({ owner: "alice", name: "internal", type: "internal", order: 1 }),
    ])

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.map((item) => `${item.type}:${item.name}:${item.owner}`)).toEqual([
      "internal:internal:alice",
      "customer:customer:alice",
      "own:same:alice",
      "own:same:bob",
    ])
  })
})
