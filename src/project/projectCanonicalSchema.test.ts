import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { projectCanonicalSchema } from "./projectCanonicalSchema.js"

describe("projectCanonicalSchema", () => {
  test("parses project-owned services with their own Caddy settings", () => {
    const result = a.safeParse(projectCanonicalSchema, {
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      services: [
        {
          id: "primary",
          units: ["catalog.service"],
          caddy: {
            port: 3000,
            domains: ["catalog.example"],
            path: "/srv/catalog",
            access: "internal",
            kind: "static",
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
          },
        },
      ],
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.output.services).toHaveLength(1)
    expect(result.output.services[0]?.id).toBe("primary")
    expect(result.output.services[0]?.caddy).toMatchObject({
      port: 3000,
      domains: ["catalog.example"],
      path: "/srv/catalog",
      access: "internal",
      kind: "static",
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
    })
  })

  test("requires unique stable service IDs and rejects the legacy project Caddy field", () => {
    const duplicate = a.safeParse(projectCanonicalSchema, {
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      services: [
        { id: "primary", caddy: null },
        { id: "primary", caddy: null },
      ],
    })
    const legacyCaddy = a.safeParse(projectCanonicalSchema, {
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      caddy: { port: 3000, domains: ["catalog.example"] },
    })

    expect(duplicate.success).toBe(false)
    expect(legacyCaddy.success).toBe(false)
  })
})
