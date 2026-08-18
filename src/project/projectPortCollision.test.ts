import { describe, expect, test } from "bun:test"
import { projectNormalize } from "./projectNormalize.js"
import { projectPortCollision } from "./projectPortCollision.js"
import type { Project } from "./projectSchema.js"

function project(owner: string, name: string, port: number, disabled = false): Project {
  const result = projectNormalize({
    owner,
    name,
    caddy: { port, domains: [`${name}.example`], disabled },
  })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("projectPortCollision", () => {
  test("returns an active project using the port and excludes the persisted project key", () => {
    const persisted = project("alice", "first", 3000)
    const other = project("bob", "second", 3000)

    expect(projectPortCollision([persisted, other], 3000, { owner: "alice", name: "first" })).toBe(other)
  })

  test("ignores disabled and catalog-only projects", () => {
    const catalogOnly = projectNormalize({ owner: "alice", name: "catalog" })
    if (!catalogOnly.success) throw new Error(catalogOnly.errorMessage)

    expect(projectPortCollision([catalogOnly.data, project("bob", "disabled", 3000, true)], 3000)).toBeNull()
  })
})
