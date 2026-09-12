import { describe, expect, test } from "bun:test"
import { projectNormalize } from "./projectNormalize.js"
import type { Project } from "./projectSchema.js"
import { projectSort } from "./projectSort.js"

function project(input: { owner: string; name: string; order: number; labels?: Record<string, string> }): Project {
  const result = projectNormalize(input)
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("projectSort", () => {
  test("sorts by Software group, order, name, then owner without mutating input", () => {
    const projects = [
      project({ owner: "bob", name: "same", order: 1, labels: { section: "Eigene" } }),
      project({ owner: "alice", name: "same", order: 1, labels: { section: "Eigene" } }),
      project({ owner: "alice", name: "later", order: 2, labels: { section: "Kunden" } }),
      project({ owner: "alice", name: "first", order: 99, labels: { section: "Interne" } }),
    ]

    const sorted = projectSort(projects)

    expect(sorted.map((item) => `${item.labels.section}:${item.name}:${item.owner}`)).toEqual([
      "Interne:first:alice",
      "Kunden:later:alice",
      "Eigene:same:alice",
      "Eigene:same:bob",
    ])
    expect(projects[0]?.owner).toBe("bob")
  })

  test("sorts arbitrary sections deterministically after the built-in sections", () => {
    const projects = [
      project({
        owner: "alice",
        name: "production",
        order: 1,
        labels: { section: "Produktion Infrastruktur" },
      }),
      project({ owner: "alice", name: "internal", order: 1, labels: { section: "Interne" } }),
      project({
        owner: "alice",
        name: "development",
        order: 1,
        labels: { section: "Entwicklung Infrastruktur" },
      }),
    ]

    expect(projectSort(projects).map((item) => item.labels.section)).toEqual([
      "Interne",
      "Entwicklung Infrastruktur",
      "Produktion Infrastruktur",
    ])
  })
})
