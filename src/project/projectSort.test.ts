import { describe, expect, test } from "bun:test"
import { projectNormalize } from "./projectNormalize.js"
import type { Project } from "./projectSchema.js"
import { projectSort } from "./projectSort.js"

function project(input: {
  owner: string
  name: string
  type: "own" | "internal" | "customer"
  order: number
}): Project {
  const result = projectNormalize(input)
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("projectSort", () => {
  test("sorts by Software group, order, name, then owner without mutating input", () => {
    const projects = [
      project({ owner: "bob", name: "same", type: "own", order: 1 }),
      project({ owner: "alice", name: "same", type: "own", order: 1 }),
      project({ owner: "alice", name: "later", type: "customer", order: 2 }),
      project({ owner: "alice", name: "first", type: "internal", order: 99 }),
    ]

    const sorted = projectSort(projects)

    expect(sorted.map((item) => `${item.type}:${item.name}:${item.owner}`)).toEqual([
      "internal:first:alice",
      "customer:later:alice",
      "own:same:alice",
      "own:same:bob",
    ])
    expect(projects[0]?.owner).toBe("bob")
  })
})
