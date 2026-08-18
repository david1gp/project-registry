import { describe, expect, test } from "bun:test"
import { projectNormalize } from "./projectNormalize.js"
import { projectPortNext } from "./projectPortNext.js"
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

describe("projectPortNext", () => {
  test("returns the lowest available port and ignores disabled projects", () => {
    const result = projectPortNext([
      project("alice", "first", 3000),
      project("bob", "disabled", 3001, true),
      project("alice", "third", 3003),
    ])

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe(3001)
  })

  test("returns an expected failure when the range is full", () => {
    const result = projectPortNext([project("alice", "first", 4000), project("bob", "second", 4001)], {
      from: 4000,
      to: 4001,
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("no free port")
  })

  test("accepts the inclusive allocation boundaries", () => {
    const first = projectPortNext([], { from: 1, to: 1 })
    const last = projectPortNext([], { from: 65535, to: 65535 })

    expect(first).toMatchObject({ success: true, data: 1 })
    expect(last).toMatchObject({ success: true, data: 65535 })
  })

  test("rejects invalid ranges", () => {
    const ranges = [
      { from: 0, to: 1 },
      { from: 1, to: 65536 },
      { from: 1.5, to: 2 },
      { from: 2, to: 1 },
      { from: Number.NaN, to: 2 },
      { from: 1, to: Number.POSITIVE_INFINITY },
    ]

    for (const range of ranges) expect(projectPortNext([], range).success).toBe(false)
  })

  test("does not reserve disabled projects or catalog-only projects", () => {
    const catalogOnly = projectNormalize({ owner: "alice", name: "catalog" })
    if (!catalogOnly.success) throw new Error(catalogOnly.errorMessage)

    const result = projectPortNext([catalogOnly.data, project("bob", "disabled", 3000, true)])

    expect(result).toMatchObject({ success: true, data: 3000 })
  })
})
