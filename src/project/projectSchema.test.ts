import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { projectInputSchema } from "./projectInputSchema.js"
import { projectSchema } from "./projectSchema.js"

describe("projectSchema", () => {
  test("requires the versioned owner/name identity and applies metadata defaults", () => {
    const result = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.output.type).toBe("customer")
    expect(result.output.order).toBe(Number.MAX_SAFE_INTEGER)
    expect(result.output.services).toEqual([])
    expect(result.output.labels).toEqual({})
    expect("caddy" in result.output).toBe(false)

    const input = a.safeParse(projectInputSchema, { owner: "alice", name: "catalog" })
    expect(input.success).toBe(true)
    if (!input.success) return
    expect(input.output.labels).toEqual({})
  })

  test("keeps caddy settings nested and rejects invalid service units", () => {
    const result = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      services: ["catalog.service", "worker@preview", "bad/unit"],
    })

    expect(result.success).toBe(false)
  })

  test("rejects unknown persisted fields at the project and caddy levels", () => {
    const projectResult = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      shared: true,
    })
    const caddyResult = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      caddy: {
        port: 3000,
        domains: ["catalog.example"],
        template: "legacy",
      },
    })

    expect(projectResult.success).toBe(false)
    expect(caddyResult.success).toBe(false)
  })

  test("allows a missing caddy port only in the input schema", () => {
    const input = a.safeParse(projectInputSchema, {
      owner: "alice",
      name: "catalog",
      caddy: { domains: ["catalog.example"] },
    })
    const document = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      caddy: { domains: ["catalog.example"] },
    })

    expect(input.success).toBe(true)
    expect(document.success).toBe(false)
  })

  test("keeps legacy empty and whitespace Caddy optionals valid in both schemas", () => {
    const fields = ["routed", "docsPath", "browseTemplate"] as const

    for (const value of ["", "   "]) {
      const caddy = {
        port: 3000,
        domains: ["catalog.example"],
        ...Object.fromEntries(fields.map((field) => [field, value])),
        staticAllow: [],
      }
      const persisted = a.safeParse(projectSchema, {
        schemaVersion: 1,
        owner: "alice",
        name: "catalog",
        caddy,
      })
      const input = a.safeParse(projectInputSchema, {
        owner: "alice",
        name: "catalog",
        caddy,
      })

      expect(persisted.success).toBe(true)
      expect(input.success).toBe(true)
      if (!persisted.success || !input.success) continue
      expect(persisted.output.caddy).toMatchObject({ ...caddy })
      expect(input.output.caddy).toMatchObject({ ...caddy })
    }
  })

  test("preserves legacy OIDC path lists in both schemas", () => {
    for (const oidcPaths of [[], ["   "], [" /private/* "]]) {
      const caddy = {
        port: 3000,
        domains: ["catalog.example"],
        oidcPaths,
      }
      const persisted = a.safeParse(projectSchema, {
        schemaVersion: 1,
        owner: "alice",
        name: "catalog",
        caddy,
      })
      const input = a.safeParse(projectInputSchema, {
        owner: "alice",
        name: "catalog",
        caddy,
      })

      expect(persisted.success).toBe(true)
      expect(input.success).toBe(true)
      if (!persisted.success || !input.success || !persisted.output.caddy || !input.output.caddy) continue
      expect(persisted.output.caddy.oidcPaths).toEqual(oidcPaths)
      expect(input.output.caddy.oidcPaths).toEqual(oidcPaths)
    }
  })

  test("preserves reserved header names while copying only own data properties", () => {
    const inherited = { inherited: "drop", polluted: "drop" }
    const headerUp = Object.create(inherited) as Record<string, string>
    headerUp.Host = "good"
    Object.defineProperty(headerUp, "constructor", { enumerable: true, value: "constructor-value" })
    Object.defineProperty(headerUp, "prototype", { enumerable: true, value: "prototype-value" })
    Object.defineProperty(headerUp, "__proto__", { enumerable: true, value: "dunder-value" })

    const persisted = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      caddy: { port: 3000, domains: ["catalog.example"], headerUp },
    })
    const input = a.safeParse(projectInputSchema, {
      owner: "alice",
      name: "catalog",
      caddy: { port: 3000, domains: ["catalog.example"], headerUp },
    })

    expect(persisted.success).toBe(true)
    expect(input.success).toBe(true)
    if (!persisted.success || !persisted.output.caddy || !input.success || !input.output.caddy) return

    const expected = Object.fromEntries([
      ["Host", "good"],
      ["constructor", "constructor-value"],
      ["prototype", "prototype-value"],
      ["__proto__", "dunder-value"],
    ])
    for (const output of [persisted.output.caddy.headerUp, input.output.caddy.headerUp]) {
      expect(Object.keys(output)).toEqual(["Host", "constructor", "prototype", "__proto__"])
      expect(output).toEqual(expected)
      expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
      expect("inherited" in output).toBe(false)
      expect("polluted" in output).toBe(false)
    }
  })

  test("preserves reserved label names and rejects blank keys and non-string values", () => {
    const labels = Object.create({ inherited: "drop" }) as Record<string, string>
    labels.good = "value"
    Object.defineProperty(labels, "constructor", { enumerable: true, value: "constructor-value" })
    Object.defineProperty(labels, "prototype", { enumerable: true, value: "prototype-value" })
    Object.defineProperty(labels, "__proto__", { enumerable: true, value: "dunder-value" })

    const persisted = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      labels,
    })
    const blankKey = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      labels: { " ": "value" },
    })
    const nonStringValue = a.safeParse(projectSchema, {
      schemaVersion: 1,
      owner: "alice",
      name: "catalog",
      labels: { good: 1 },
    })

    expect(persisted.success).toBe(true)
    expect(blankKey.success).toBe(false)
    expect(nonStringValue.success).toBe(false)
    if (!persisted.success) return
    expect(persisted.output.labels).toEqual(
      Object.fromEntries([
        ["good", "value"],
        ["constructor", "constructor-value"],
        ["prototype", "prototype-value"],
        ["__proto__", "dunder-value"],
      ]),
    )
    expect(Object.getPrototypeOf(persisted.output.labels)).toBe(Object.prototype)
    expect("inherited" in persisted.output.labels).toBe(false)
  })
})
