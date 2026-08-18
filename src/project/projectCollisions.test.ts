import { describe, expect, test } from "bun:test"
import { projectCollisions } from "./projectCollisions.js"
import { projectNormalize } from "./projectNormalize.js"
import type { Project } from "./projectSchema.js"

function project(owner: string, name: string, port: number, domain: string, disabled = false): Project {
  const result = projectNormalize({
    owner,
    name,
    caddy: { port, domains: [domain], disabled },
  })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("projectCollisions", () => {
  test("rejects active port collisions across owners", () => {
    const result = projectCollisions([
      project("alice", "first", 3000, "first.example"),
      project("bob", "second", 3000, "second.example"),
    ])

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("active port collision")
  })

  test("rejects active domains case-insensitively and ignores disabled projects", () => {
    const result = projectCollisions([
      project("alice", "first", 3000, "App.Example."),
      project("bob", "second", 3001, "app.example"),
      project("carol", "disabled", 3000, "App.Example.", true),
    ])

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("active domain collision")
  })

  test("allows disabled projects and excludes the edited key", () => {
    const result = projectCollisions(
      [project("alice", "first", 3000, "app.example"), project("bob", "second", 3000, "app.example", true)],
      { owner: "alice", name: "first" },
    )

    expect(result.success).toBe(true)
  })

  test("checks a replacement against every other active project", () => {
    const persisted = project("alice", "first", 3000, "old.example")
    const other = project("bob", "second", 3001, "other.example")
    const replacement = project("alice", "first", 3002, "OTHER.EXAMPLE...")

    const result = projectCollisions([persisted, other], {
      excludeKey: { owner: persisted.owner, name: persisted.name },
      replacement,
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("active domain collision")
  })

  test("rejects duplicate project keys", () => {
    const result = projectCollisions([
      project("alice", "first", 3000, "first.example"),
      project("alice", "first", 3001, "second.example"),
    ])

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("project key collision")
  })

  test("compares slash-containing owners structurally when excluding a project", () => {
    const persisted = project("team/alpha", "app", 3000, "old.example")
    const replacement = project("team/alpha", "app", 3000, "new.example")

    const result = projectCollisions([persisted], {
      excludeKey: { owner: "team/alpha", name: "app" },
      replacement,
    })

    expect(result.success).toBe(true)
  })

  test("does not reserve catalog-only or disabled Caddy records", () => {
    const catalogOnly = projectNormalize({ owner: "alice", name: "catalog" })
    const disabled = project("bob", "disabled", 3000, "disabled.example", true)
    if (!catalogOnly.success) throw new Error(catalogOnly.errorMessage)

    const result = projectCollisions([catalogOnly.data, disabled, project("carol", "active", 3000, "active.example")])

    expect(result.success).toBe(true)
  })
})
