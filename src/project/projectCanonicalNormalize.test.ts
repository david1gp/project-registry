import { describe, expect, test } from "bun:test"
import type { Project } from "./Project.js"
import { projectCanonicalNormalize } from "./projectCanonicalNormalize.js"
import { projectPortNext } from "./projectPortNext.js"

describe("projectCanonicalNormalize", () => {
  test("normalizes missing canonical service ownership to registry", () => {
    const result = projectCanonicalNormalize({
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      services: [
        { id: "api", units: [], caddy: null },
        { id: "convex", ownership: "external", caddy: null },
      ],
    })

    expect(result).toMatchObject({
      success: true,
      data: {
        services: [
          { id: "api", ownership: "registry" },
          { id: "convex", ownership: "external" },
        ],
      },
    })
  })

  test("reads a type-bearing canonical record and emits only its normalized section", () => {
    const result = projectCanonicalNormalize({
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      type: "internal",
      services: [],
    })

    expect(result).toMatchObject({ success: true, data: { labels: { section: "Interne" } } })
    if (result.success) expect(Object.hasOwn(result.data, "type")).toBe(false)
  })

  test("allocates a persisted port for a portless external Caddy service without reserving it locally", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "pages",
        services: [{ id: "pages", units: [], ownership: "external", caddy: { domains: ["pages.example"] } }],
      },
      { portRange: { from: 3100, to: 3100 } },
    )

    expect(result).toMatchObject({
      success: true,
      data: {
        services: [{ id: "pages", ownership: "external", caddy: { port: 3100, domains: ["pages.example"] } }],
      },
    })
    if (!result.success) return
    expect(projectPortNext([result.data], { from: 3100, to: 3100 })).toEqual({ success: true, data: 3100 })
  })

  test("reserves occupied and explicit project ports while allocating a new sibling", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        services: [
          { id: "existing", units: [], caddy: { port: 3200, domains: ["existing.example"] } },
          { id: "explicit", units: [], caddy: { port: 3201, domains: ["explicit.example"] } },
          { id: "sibling", units: [], ownership: "registry", caddy: { domains: ["sibling.example"] } },
        ],
      },
      {
        excludeProject: {
          schemaVersion: 2,
          owner: "alice",
          name: "catalog",
          services: [
            { id: "existing", units: [], ownership: "registry", caddy: { port: 3200, domains: ["existing.example"] } },
          ],
        } as unknown as Project,
        allocatePortServiceIds: ["sibling"],
        portRange: { from: 3200, to: 3202 },
      },
    )

    expect(result).toMatchObject({
      success: true,
      data: { services: [{ id: "existing" }, { id: "explicit" }, { id: "sibling", caddy: { port: 3202 } }] },
    })
  })

  test("fails when every configured port is occupied by siblings or explicit submissions", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        services: [
          { id: "explicit", units: [], caddy: { port: 3200, domains: ["explicit.example"] } },
          { id: "sibling", units: [], caddy: { domains: ["sibling.example"] } },
        ],
      },
      {
        allocatePortServiceIds: ["sibling"],
        portRange: { from: 3200, to: 3200 },
      },
    )

    expect(result).toMatchObject({ success: false, errorMessage: "no free port in range 3200-3200" })
  })

  test("does not reserve a disabled submitted port for a local sibling", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        services: [
          { id: "disabled", units: [], caddy: { port: 3200, domains: ["disabled.example"], disabled: true } },
          { id: "sibling", units: [], caddy: { domains: ["sibling.example"] } },
        ],
      },
      { allocatePortServiceIds: ["sibling"], portRange: { from: 3200, to: 3200 } },
    )

    expect(result).toMatchObject({
      success: true,
      data: {
        services: [
          { id: "disabled", caddy: { port: 3200 } },
          { id: "sibling", caddy: { port: 3200 } },
        ],
      },
    })
  })

  test("does not reserve a nonlocal submitted port for a local sibling", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        services: [
          { id: "pages", units: [], caddy: { port: 3200, domains: ["catalog.pages.dev"] } },
          { id: "sibling", units: [], caddy: { domains: ["sibling.example"] } },
        ],
      },
      { allocatePortServiceIds: ["sibling"], portRange: { from: 3200, to: 3200 } },
    )

    expect(result).toMatchObject({
      success: true,
      data: {
        services: [
          { id: "pages", caddy: { port: 3200 } },
          { id: "sibling", caddy: { port: 3200 } },
        ],
      },
    })
  })

  test("does not reserve a disabled existing port for a local sibling", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        services: [{ id: "sibling", units: [], caddy: { domains: ["sibling.example"] } }],
      },
      {
        excludeProject: {
          schemaVersion: 2,
          owner: "alice",
          name: "catalog",
          services: [
            {
              id: "existing",
              units: [],
              ownership: "registry",
              caddy: { port: 3200, domains: ["existing.example"], disabled: true },
            },
          ],
        } as unknown as Project,
        allocatePortServiceIds: ["sibling"],
        portRange: { from: 3200, to: 3200 },
      },
    )

    expect(result).toMatchObject({ success: true, data: { services: [{ id: "sibling", caddy: { port: 3200 } }] } })
  })

  test("reuses a same-project port removed by the submitted collection", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        services: [{ id: "sibling", units: [], caddy: { domains: ["sibling.example"] } }],
      },
      {
        excludeProject: {
          schemaVersion: 2,
          owner: "alice",
          name: "catalog",
          services: [
            { id: "existing", units: [], ownership: "registry", caddy: { port: 3200, domains: ["existing.example"] } },
          ],
        } as unknown as Project,
        allocatePortServiceIds: ["sibling"],
        portRange: { from: 3200, to: 3200 },
      },
    )

    expect(result).toMatchObject({ success: true, data: { services: [{ id: "sibling", caddy: { port: 3200 } }] } })
  })

  test("does not reserve a newly allocated external port for an active local sibling", () => {
    const result = projectCanonicalNormalize(
      {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        services: [
          { id: "pages", units: [], ownership: "external", caddy: { domains: ["pages.example"] } },
          { id: "sibling", units: [], ownership: "registry", caddy: { domains: ["sibling.example"] } },
        ],
      },
      {
        allocatePortServiceIds: ["sibling"],
        portRange: { from: 3200, to: 3200 },
      },
    )

    expect(result).toMatchObject({
      success: true,
      data: {
        services: [
          { id: "pages", ownership: "external", caddy: { port: 3200 } },
          { id: "sibling", ownership: "registry", caddy: { port: 3200 } },
        ],
      },
    })
  })
})
