import { describe, expect, test } from "bun:test"
import { projectCanonicalNormalize } from "./projectCanonicalNormalize.js"

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
})
