import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import { projectNormalize } from "../project/projectNormalize.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import { caddyConfigOptionsSchema } from "./caddyConfigOptionsSchema.js"

function hostsOf(config: { apps: { http: { servers: { srv0: { routes: unknown[] } } } } }): string[][] {
  const routes = config.apps.http.servers.srv0.routes as Array<{ match: Array<{ host: string[] }> }>
  return routes.map((route) => route.match[0]!.host)
}

function listensOf(config: { apps: { http: { servers: { srv0: { listen: string[] } } } } }): string[] {
  return config.apps.http.servers.srv0.listen
}

function loggerNamesOf(config: { apps: { http: { servers: { srv0: { logs?: unknown } } } } }): unknown {
  return (config.apps.http.servers.srv0.logs as { logger_names: unknown } | undefined)?.logger_names
}

describe("caddyConfigGenerate networkVisibility", () => {
  test("omits private entries from the default public generation", () => {
    const privateProject = projectNormalize({
      ...caddyConfigGenerateFixtures.proxy,
      name: "opencode-temp",
      caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, networkVisibility: "private" },
    })
    expect(privateProject.success).toBe(true)
    if (!privateProject.success) return

    const result = caddyConfigGenerate([privateProject.data])

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(hostsOf(result.data)).toEqual([])
    expect(result.data.apps.http.servers.srv0.listen).toEqual([":443"])
    expect(JSON.stringify(result.data)).not.toContain("opencode.example")
  })

  test("includes private entries only in the private generation", () => {
    const privateProject = projectNormalize({
      ...caddyConfigGenerateFixtures.proxy,
      name: "opencode-temp",
      caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, networkVisibility: "private" },
    })
    expect(privateProject.success).toBe(true)
    if (!privateProject.success) return

    const result = caddyConfigGenerate([privateProject.data], { networkVisibility: "private" })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(hostsOf(result.data)).toEqual([["opencode.example", "oc.example"]])
  })

  test("keeps entries without visibility in the default public generation", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy])

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(hostsOf(result.data)).toEqual([["opencode.example", "oc.example"]])
  })

  test("partitions mixed public and private services of one project", () => {
    const project = {
      schemaVersion: 2,
      owner: "leo",
      name: "temp",
      services: [
        {
          id: "public-web",
          units: ["temp-web.service"],
          caddy: { port: 4108, domains: ["public.example"], networkVisibility: "public" },
        },
        {
          id: "private-app",
          units: ["temp-app.service"],
          caddy: { port: 4109, domains: ["private.example"], networkVisibility: "private" },
        },
      ],
    }

    const publicResult = caddyConfigGenerate([project])
    expect(publicResult.success).toBe(true)
    if (!publicResult.success) return
    expect(hostsOf(publicResult.data)).toEqual([["public.example"]])
    expect(JSON.stringify(publicResult.data)).not.toContain("private.example")

    const privateResult = caddyConfigGenerate([project], { networkVisibility: "private" })
    expect(privateResult.success).toBe(true)
    if (!privateResult.success) return
    expect(hostsOf(privateResult.data)).toEqual([["private.example"]])
    expect(JSON.stringify(privateResult.data)).not.toContain("public.example")
  })

  test("allows the same domain in public and private generations without collision", () => {
    const projects = [
      { ...caddyConfigGenerateFixtures.proxy, name: "public-route" },
      {
        ...caddyConfigGenerateFixtures.proxy,
        name: "private-route",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, networkVisibility: "private" as const },
      },
    ]

    const publicResult = caddyConfigGenerate(projects)
    expect(publicResult.success).toBe(true)
    if (!publicResult.success) return
    expect(hostsOf(publicResult.data)).toEqual([["opencode.example", "oc.example"]])

    const privateResult = caddyConfigGenerate(projects, { networkVisibility: "private" })
    expect(privateResult.success).toBe(true)
  })

  test("restricts docs routes and access-log maps to the selected visibility", () => {
    const projects = [
      caddyConfigGenerateFixtures.proxyDocs,
      {
        ...caddyConfigGenerateFixtures.proxyDocs,
        name: "private-docs",
        caddy: {
          ...caddyConfigGenerateFixtures.proxyDocs.caddy,
          domains: ["private-docs.example"],
          networkVisibility: "private" as const,
        },
      },
    ]
    const options = { caddyAccessLogRoot: "/var/lib/project-registry/caddy-access-logs" }

    const publicResult = caddyConfigGenerate(projects, options)
    expect(publicResult.success).toBe(true)
    if (!publicResult.success) return
    expect(hostsOf(publicResult.data)).toEqual([["startup.example"]])
    expect(JSON.stringify(publicResult.data)).not.toContain("private-docs.example")
    expect(Object.keys((loggerNamesOf(publicResult.data) as Record<string, unknown>) ?? {})).toEqual([
      "startup.example",
    ])

    const privateResult = caddyConfigGenerate(projects, { ...options, networkVisibility: "private" })
    expect(privateResult.success).toBe(true)
    if (!privateResult.success) return
    expect(hostsOf(privateResult.data)).toEqual([["private-docs.example"]])
    expect(JSON.stringify(privateResult.data)).not.toContain("startup.example")
  })

  test("uses explicit httpsListeners while retaining the legacy httpsListener", () => {
    const explicit = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListeners: [":8443", ":8444"] })
    expect(explicit.success).toBe(true)
    if (!explicit.success) return
    expect(listensOf(explicit.data)).toEqual([":8443", ":8444"])

    const legacy = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListener: ":8443" })
    expect(legacy.success).toBe(true)
    if (!legacy.success) return
    expect(listensOf(legacy.data)).toEqual([":8443"])
  })

  test("passes explicit IP httpsListeners through to the generated server", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], {
      httpsListeners: ["203.0.113.10:443", "[2001:db8::1]:443"],
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(listensOf(result.data)).toEqual(["203.0.113.10:443", "[2001:db8::1]:443"])
  })

  test("rejects invalid httpsListeners and networkVisibility options", () => {
    expect(caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListeners: [] }).success).toBe(false)
    expect(caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListeners: ["8443"] }).success).toBe(false)
    expect(
      caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListeners: ["999.0.0.1:443"] }).success,
    ).toBe(false)
    expect(caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListeners: ["127.0.0.1:0"] }).success).toBe(
      false,
    )
    expect(caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListeners: ["[::1]:65536"] }).success).toBe(
      false,
    )
    expect(caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { networkVisibility: "tailnet" }).success).toBe(
      false,
    )
  })

  test("caddyConfigOptionsSchema defaults to the public listener", () => {
    const result = a.safeParse(caddyConfigOptionsSchema, {})

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.output).toEqual({ httpsListener: ":443", networkVisibility: "public" })
  })

  test("projectNormalize preserves private visibility through the legacy input", () => {
    const result = projectNormalize({
      owner: "leo",
      name: "opencode-temp",
      caddy: { port: 4108, domains: ["opencode-temp.example"], networkVisibility: "private" },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.caddy?.networkVisibility).toBe("private")

    const generated = caddyConfigGenerate([result.data], { networkVisibility: "private" })
    expect(generated.success).toBe(true)
    if (!generated.success) return
    expect(hostsOf(generated.data)).toEqual([["opencode-temp.example"]])

    const publicGenerated = caddyConfigGenerate([result.data])
    expect(publicGenerated.success).toBe(true)
    if (!publicGenerated.success) return
    expect(hostsOf(publicGenerated.data)).toEqual([])
  })

  test("projectNormalize rejects unknown visibility values", () => {
    const result = projectNormalize({
      owner: "leo",
      name: "opencode-temp",
      caddy: { port: 4108, domains: ["opencode-temp.example"], networkVisibility: "tailnet" },
    })

    expect(result.success).toBe(false)
  })
})
