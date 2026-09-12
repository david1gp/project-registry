import { describe, expect, test } from "bun:test"
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
})
