import { describe, expect, test } from "bun:test"
import { projectNormalize } from "./projectNormalize.js"

describe("projectNormalize", () => {
  test("normalizes Software metadata and legacy link names", () => {
    const result = projectNormalize({
      owner: " alice ",
      name: "catalog",
      type: " INTERNAL ",
      order: "12 items",
      services: [" api.service ", "api.service", "bad/unit", "worker@preview"],
      preview_port: 3100,
      production_url: " https://catalog.example ",
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({
      schemaVersion: 1,
      owner: "alice",
      type: "internal",
      order: 12,
      services: ["api.service", "worker@preview"],
      previewPort: "3100",
      productionUrl: "https://catalog.example",
    })
  })

  test("allocates the lowest free port for caddy-enabled projects", () => {
    const result = projectNormalize(
      {
        owner: "alice",
        name: "catalog",
        caddy: { domains: ["catalog.example"] },
      },
      {
        projects: [
          {
            schemaVersion: 1,
            owner: "bob",
            name: "first",
            type: "customer",
            order: 1,
            services: [],
            labels: {},
            caddy: {
              port: 3000,
              domains: ["first.example"],
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
      },
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.caddy?.port).toBe(3001)
  })

  test("generates a project subdomain from the owner's configured default domain", () => {
    const result = projectNormalize(
      {
        owner: "leo",
        name: "api",
        caddy: {},
      },
      { defaultUserDomains: { leo: "leonardomora.de" } },
    )

    expect(result).toMatchObject({ success: true, data: { caddy: { domains: ["api.leonardomora.de"] } } })
  })

  test("normalizes and deduplicates domains while dropping empty values", () => {
    const result = projectNormalize({
      owner: "alice",
      name: "catalog",
      caddy: { domains: [" App.Example... ", "app.example.", "."] },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.caddy?.domains).toEqual(["app.example"])
  })

  test("rejects a replacement collision with another active project", () => {
    const persisted = projectNormalize({
      owner: "alice",
      name: "catalog",
      caddy: { port: 3000, domains: ["old.example"] },
    })
    const other = projectNormalize({
      owner: "bob",
      name: "other",
      caddy: { port: 3001, domains: ["other.example"] },
    })
    if (!persisted.success || !other.success) throw new Error("fixture normalization failed")

    const result = projectNormalize(
      { owner: "alice", name: "catalog", caddy: { port: 3002, domains: ["other.example"] } },
      {
        projects: [persisted.data, other.data],
        excludeKey: { owner: "alice", name: "catalog" },
      },
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("active domain collision")
  })

  test("rejects a replacement port collision with another active project", () => {
    const persisted = projectNormalize({
      owner: "alice",
      name: "catalog",
      caddy: { port: 3000, domains: ["old.example"] },
    })
    const other = projectNormalize({
      owner: "bob",
      name: "other",
      caddy: { port: 3001, domains: ["other.example"] },
    })
    if (!persisted.success || !other.success) throw new Error("fixture normalization failed")

    const result = projectNormalize(
      { owner: "alice", name: "catalog", caddy: { port: 3001, domains: ["new.example"] } },
      {
        projects: [persisted.data, other.data],
        excludeProject: { ...persisted.data },
      },
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("active port collision")
  })

  test("allocates a replacement port from a one-port range after excluding the persisted project", () => {
    const persisted = projectNormalize({
      owner: "alice",
      name: "catalog",
      caddy: { port: 3000, domains: ["old.example"] },
    })
    if (!persisted.success) throw new Error(persisted.errorMessage)

    const result = projectNormalize(
      { owner: "alice", name: "catalog", caddy: { domains: ["new.example"] } },
      {
        projects: [persisted.data],
        excludeProject: persisted.data,
        portRange: { from: 3000, to: 3000 },
      },
    )

    expect(result).toMatchObject({ success: true, data: { caddy: { port: 3000 } } })
  })

  test("sanitizes service values without coercing non-strings", () => {
    const result = projectNormalize({
      owner: "alice",
      name: "catalog",
      services: [" api.service ", "api.service", "worker@preview.service", " ", "bad/unit", 123, null],
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.services).toEqual(["api.service", "worker@preview.service"])
  })

  test("preserves safe label records and rejects invalid label entries", () => {
    const labels = Object.create({ inherited: "drop" }) as Record<string, string>
    labels.team = "platform"
    Object.defineProperty(labels, "__proto__", { enumerable: true, value: "reserved" })

    const result = projectNormalize({ owner: "alice", name: "catalog", labels })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.labels).toEqual(
      Object.fromEntries([
        ["team", "platform"],
        ["__proto__", "reserved"],
      ]),
    )
    expect("inherited" in result.data.labels).toBe(false)

    const invalid = projectNormalize({ owner: "alice", name: "catalog", labels: { team: 1 } })
    expect(invalid.success).toBe(false)
  })

  test("omits empty legacy Caddy optionals from canonical input", () => {
    const result = projectNormalize({
      owner: "alice",
      name: "catalog",
      caddy: {
        domains: ["catalog.example"],
        routed: " ",
        docsPath: "",
        browseTemplate: "   ",
        staticAllow: [],
      },
    })

    expect(result.success).toBe(true)
    if (!result.success || !result.data.caddy) return

    expect("routed" in result.data.caddy).toBe(false)
    expect("docsPath" in result.data.caddy).toBe(false)
    expect("browseTemplate" in result.data.caddy).toBe(false)
    expect("staticAllow" in result.data.caddy).toBe(false)
  })

  test("preserves legacy OIDC path lists without trimming or dropping entries", () => {
    for (const oidcPaths of [[], ["   "], [" /private/* "]]) {
      const result = projectNormalize({
        owner: "alice",
        name: "catalog",
        caddy: { domains: ["catalog.example"], oidcPaths },
      })

      expect(result.success).toBe(true)
      if (!result.success) continue
      expect(result.data.caddy?.oidcPaths).toEqual(oidcPaths)
    }
  })

  test("preserves reserved header names and ignores inherited header values", () => {
    const inherited = { inherited: "drop" }
    const headerUp = Object.create(inherited) as Record<string, string>
    headerUp.Host = "good"
    Object.defineProperty(headerUp, "constructor", { enumerable: true, value: "constructor-value" })
    Object.defineProperty(headerUp, "prototype", { enumerable: true, value: "prototype-value" })

    const result = projectNormalize({
      owner: "alice",
      name: "catalog",
      caddy: { domains: ["catalog.example"], headerUp },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.caddy?.headerUp).toEqual({
      Host: "good",
      constructor: "constructor-value",
      prototype: "prototype-value",
    })
    expect("inherited" in (result.data.caddy?.headerUp ?? {})).toBe(false)
  })
})
