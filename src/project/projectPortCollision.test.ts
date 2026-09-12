import { describe, expect, test } from "bun:test"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"
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

function canonicalProject(): ProjectCanonical {
  return {
    schemaVersion: 2,
    owner: "alice",
    name: "catalog",
    order: Number.MAX_SAFE_INTEGER,
    labels: {},
    services: [
      {
        id: "api",
        units: [],
        ownership: "registry",
        caddy: {
          port: 3000,
          domains: ["api.example"],
          path: "",
          access: "external",
          kind: "proxy",
          docs: true,
          browse: false,
          headerUp: {},
          disabled: false,
          denyDotfiles: false,
          spa: false,
        },
      },
      {
        id: "assets",
        units: [],
        ownership: "external",
        caddy: {
          port: 3001,
          domains: ["assets.example"],
          path: "",
          access: "external",
          kind: "proxy",
          docs: true,
          browse: false,
          headerUp: {},
          disabled: false,
          denyDotfiles: false,
          spa: false,
        },
      },
    ],
  }
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

  test("finds a port used by any active canonical service", () => {
    const canonical = canonicalProject()
    expect(projectPortCollision([canonical], 3001)).toBeNull()
    expect(projectPortCollision([canonical], 3000)).toBe(canonical)
  })
})
