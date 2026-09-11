import { describe, expect, test } from "bun:test"
import { projectCanonicalSerialize } from "./projectCanonicalSerialize.js"
import { projectMigrate } from "./projectMigrate.js"

const legacyCaddy = {
  port: 3000,
  domains: ["catalog.example", "www.catalog.example"],
  path: "/srv/catalog",
  access: "internal" as const,
  kind: "static" as const,
  docs: false,
  browse: true,
  headerUp: { Host: "catalog.internal" },
  disabled: false,
  routed: "/api",
  oidcPaths: ["/private/*"],
  docsPath: "/docs",
  browseTemplate: "{{.Name}}",
  staticAllow: ["index.html"],
  denyDotfiles: true,
  spa: true,
  flushInterval: 5,
}

describe("projectMigrate", () => {
  test("maps the legacy single-Caddy shape to one deterministic service without losing metadata", () => {
    const result = projectMigrate({
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      description: "Catalog project",
      type: "internal",
      order: 12,
      services: ["catalog.service", "worker@preview.service"],
      labels: { team: "platform" },
      github: "https://github.com/example/catalog",
      previewUrl: "https://preview.catalog.example",
      previewPort: "3100",
      productionUrl: "https://catalog.example",
      productionAssetsUrl: "https://assets.catalog.example",
      caddy: legacyCaddy,
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      description: "Catalog project",
      type: "internal",
      order: 12,
      labels: { team: "platform" },
      github: "https://github.com/example/catalog",
      previewUrl: "https://preview.catalog.example",
      previewPort: "3100",
      productionUrl: "https://catalog.example",
      productionAssetsUrl: "https://assets.catalog.example",
    })
    expect(result.data.services).toHaveLength(1)
    expect(result.data.services[0]).toEqual({
      id: "default",
      units: ["catalog.service", "worker@preview.service"],
      caddy: legacyCaddy,
      ownership: "registry",
    })
    expect(Object.hasOwn(result.data, "caddy")).toBe(false)
  })

  test("keeps a unit-only legacy project in the deterministic service boundary", () => {
    const result = projectMigrate({
      schemaVersion: 1,
      owner: "alice",
      name: "worker",
      services: ["worker.service"],
    })

    expect(result).toMatchObject({
      success: true,
      data: {
        services: [{ id: "default", units: ["worker.service"], caddy: null }],
      },
    })
  })

  test("does not invent a service for a legacy project without Caddy or units", () => {
    const result = projectMigrate({
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      services: [],
      caddy: null,
    })

    expect(result).toMatchObject({ success: true, data: { services: [] } })
  })

  test("passes canonical multi-service documents through and rejects ambiguous shapes", () => {
    const canonical = {
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      labels: { team: "platform" },
      services: [
        { id: "api", units: ["api.service"], ownership: "external", caddy: { port: 3000, domains: ["api.example"] } },
        { id: "assets", units: [], caddy: { port: 3001, domains: ["assets.example"], kind: "static" as const } },
      ],
    }
    const mixed = projectMigrate({
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      services: ["api.service", { id: "assets" }],
      caddy: legacyCaddy,
    })

    const result = projectMigrate(canonical)
    expect(result).toMatchObject({
      success: true,
      data: {
        schemaVersion: 2,
        owner: "alice",
        name: "catalog",
        labels: { team: "platform" },
        services: [
          { id: "api", units: ["api.service"], caddy: { port: 3000, domains: ["api.example"] } },
          { id: "assets", units: [], caddy: { port: 3001, domains: ["assets.example"], kind: "static" } },
        ],
      },
    })
    if (result.success)
      expect(result.data.services.map((service) => service.ownership)).toEqual(["external", "registry"])
    expect(mixed.success).toBe(false)
  })

  test("serializes legacy input only in the canonical service shape", () => {
    const result = projectCanonicalSerialize({
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      services: [],
      caddy: legacyCaddy,
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    const serialized = JSON.parse(result.data) as Record<string, unknown>
    expect(serialized.caddy).toBeUndefined()
    expect(serialized.services).toEqual([{ id: "default", units: [], caddy: legacyCaddy, ownership: "registry" }])
  })
})
