import { describe, expect, test } from "bun:test"
import { projectList } from "./projectList.js"
import { projectNormalize } from "./projectNormalize.js"

function project(input: { owner: string; name: string; section: string; order: number }) {
  const result = projectNormalize({ ...input, labels: { section: input.section } })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("projectList", () => {
  test("returns projects in deterministic Software-compatible order", () => {
    const result = projectList([
      project({ owner: "bob", name: "same", section: "Eigene", order: 1 }),
      project({ owner: "alice", name: "same", section: "Eigene", order: 1 }),
      project({ owner: "alice", name: "customer", section: "Kunden", order: 1 }),
      project({ owner: "alice", name: "internal", section: "Interne", order: 1 }),
    ])

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.map((item) => `${item.labels.section}:${item.name}:${item.owner}`)).toEqual([
      "Interne:internal:alice",
      "Kunden:customer:alice",
      "Eigene:same:alice",
      "Eigene:same:bob",
    ])
  })
})
