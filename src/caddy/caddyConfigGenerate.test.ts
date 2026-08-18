import { describe, expect, test } from "bun:test"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import { caddyConfigOidcFixtures } from "../../test/fixtures/caddyConfigOidcFixtures.js"
import { projectNormalize } from "../project/projectNormalize.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"

function routesOf(config: {
  apps: { http: { servers: { srv0: { routes: unknown[] } } } }
}): Array<Record<string, unknown>> {
  return config.apps.http.servers.srv0.routes as Array<Record<string, unknown>>
}

function hostOf(route: Record<string, unknown>): string[] {
  const match = route.match as Array<{ host: string[] }>
  return match[0]!.host
}

function innerRoutesOf(route: Record<string, unknown>): Array<Record<string, unknown>> {
  const handle = route.handle as Array<{ routes: Array<Record<string, unknown>> }>
  return handle[0]!.routes
}

describe("caddyConfigGenerate", () => {
  test("generates active routes in deterministic domain order on HTTPS", () => {
    const projects = [
      caddyConfigGenerateFixtures.static,
      caddyConfigGenerateFixtures.catalogOnly,
      caddyConfigGenerateFixtures.disabled,
      caddyConfigGenerateFixtures.proxy,
    ]
    const result = caddyConfigGenerate(projects)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.apps.http.servers.srv0.listen).toEqual([":443"])
    expect(routesOf(result.data).map(hostOf)).toEqual([["demos.example"], ["opencode.example", "oc.example"]])
  })

  test("uses a validated custom HTTPS listener", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], { httpsListener: ":8443" })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.apps.http.servers.srv0.listen).toEqual([":8443"])
  })

  test("keeps legacy locale domain ordering without mutating input", () => {
    const projects = [
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "owner-z",
        name: "same-domain-z",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["Alpha.example"] },
      },
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "owner-b",
        name: "same-domain-b",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["same-b.example"] },
      },
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "owner-a",
        name: "same-domain-a",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["same-a.example"] },
      },
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "owner-a",
        name: "lower-domain",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["alpha.example"] },
      },
    ]
    const original = structuredClone(projects)
    const result = caddyConfigGenerate(projects)

    expect(result.success).toBe(true)
    if (!result.success) return

    const routes = routesOf(result.data)
    expect(routes.map((route) => hostOf(route)[0])).toEqual([
      "alpha.example",
      "Alpha.example",
      "same-a.example",
      "same-b.example",
    ])
    expect(projects).toEqual(original)
  })

  test("uses owner and name as deterministic tie-breakers for equivalent domains", () => {
    const projects = [
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "owner-z",
        name: "owner-z-domain",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["é.example"] },
      },
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "owner-a",
        name: "owner-a-domain",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["e\u0301.example"] },
      },
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "same-owner",
        name: "z-name",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["Å.example"] },
      },
      {
        ...caddyConfigGenerateFixtures.proxy,
        owner: "same-owner",
        name: "a-name",
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["A\u030a.example"] },
      },
    ]
    const result = caddyConfigGenerate(projects)

    expect(result.success).toBe(true)
    if (!result.success) return

    const hosts = routesOf(result.data).map((route) => hostOf(route)[0])
    expect(hosts.indexOf("e\u0301.example")).toBeLessThan(hosts.indexOf("é.example"))
    expect(hosts.indexOf("A\u030a.example")).toBeLessThan(hosts.indexOf("Å.example"))
  })

  test("generates the legacy proxy target and domains", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy])

    expect(result.success).toBe(true)
    if (!result.success) return

    const route = routesOf(result.data)[0]!
    const proxy = innerRoutesOf(route)[0]!.handle as Array<Record<string, unknown>>
    expect(proxy[0]!.handler).toBe("headers")
    expect((proxy[0]!.response as { set: { Routed: string[] } }).set.Routed).toEqual(["4096"])

    const terminal = innerRoutesOf(route).at(-1)!.handle as Array<Record<string, unknown>>
    expect(terminal[0]!.handler).toBe("reverse_proxy")
    expect(terminal[0]!.upstreams).toEqual([{ dial: "localhost:4096" }])
    expect(terminal[0]!.flush_interval).toBe(-1)
  })

  test("matches legacy internal and path-scoped OIDC route fixtures", () => {
    for (const [name, project] of Object.entries(caddyConfigOidcFixtures.projects)) {
      const result = caddyConfigGenerate([project], { oidc: caddyConfigOidcFixtures.options })

      expect(result.success).toBe(true)
      if (!result.success) continue
      expect(routesOf(result.data)[0]).toEqual(
        caddyConfigOidcFixtures.legacyRoutes[name as keyof typeof caddyConfigOidcFixtures.legacyRoutes],
      )
    }
  })

  test("places a full internal gate before docs and path gates before the fallback", () => {
    const internal = caddyConfigGenerate(
      [
        {
          ...caddyConfigGenerateFixtures.proxyDocs,
          caddy: { ...caddyConfigGenerateFixtures.proxyDocs.caddy, access: "internal" },
        },
      ],
      { oidc: caddyConfigOidcFixtures.options },
    )
    const scoped = caddyConfigGenerate(
      [
        {
          ...caddyConfigGenerateFixtures.proxyDocs,
          caddy: { ...caddyConfigGenerateFixtures.proxyDocs.caddy, oidcPaths: ["/private/*"] },
        },
      ],
      { oidc: caddyConfigOidcFixtures.options },
    )

    expect(internal.success).toBe(true)
    expect(scoped.success).toBe(true)
    if (!internal.success || !scoped.success) return

    const internalInner = innerRoutesOf(routesOf(internal.data)[0]!)
    expect((internalInner[1]!.handle as Array<Record<string, unknown>>)[0]!.handler).toBe("oidc")
    expect(internalInner[2]!.group).toBe("docs")

    const scopedInner = innerRoutesOf(routesOf(scoped.data)[0]!)
    expect(scopedInner[1]!.group).toBe("docs")
    expect(scopedInner.at(-2)!.match).toEqual([{ path: ["/private/*"] }])
    expect(scopedInner.at(-1)!.match).toBeUndefined()
  })

  test("matches legacy OIDC behavior for empty, whitespace-only, and padded paths", () => {
    const accessValues = ["internal", "external"] as const
    const pathValues = [[], ["   "], [" /private/* "]] as const
    const projects = [caddyConfigGenerateFixtures.internalProxy, caddyConfigGenerateFixtures.internalStatic]

    for (const project of projects) {
      for (const access of accessValues) {
        for (const oidcPaths of pathValues) {
          const input = {
            ...project,
            caddy: { ...project.caddy, access, oidcPaths },
          }
          const normalized = projectNormalize(input)
          const direct = caddyConfigGenerate([input], { oidc: caddyConfigOidcFixtures.options })

          expect(normalized.success).toBe(true)
          expect(direct.success).toBe(true)
          if (!normalized.success || !direct.success) continue

          const normalizedConfig = caddyConfigGenerate([normalized.data], {
            oidc: caddyConfigOidcFixtures.options,
          })
          expect(normalizedConfig).toEqual(direct)

          if (oidcPaths.length === 0) {
            const omitted = caddyConfigGenerate(
              [
                {
                  ...project,
                  caddy: { ...project.caddy, access, oidcPaths: undefined },
                },
              ],
              { oidc: caddyConfigOidcFixtures.options },
            )
            expect(omitted.success).toBe(true)
            if (!omitted.success) continue
            expect(direct).toEqual(omitted)

            if (access === "internal") {
              const expectedName = project.caddy.kind === "proxy" ? "internalProxy" : "internalStatic"
              expect(routesOf(direct.data)[0]).toEqual(
                caddyConfigOidcFixtures.legacyRoutes[expectedName as "internalProxy" | "internalStatic"],
              )
            }
            continue
          }

          const oppositeAccess = access === "internal" ? "external" : "internal"
          const opposite = caddyConfigGenerate([{ ...input, caddy: { ...input.caddy, access: oppositeAccess } }], {
            oidc: caddyConfigOidcFixtures.options,
          })
          expect(opposite.success).toBe(true)
          if (!opposite.success) continue
          expect(opposite).toEqual(direct)

          const inner = innerRoutesOf(routesOf(direct.data)[0]!)
          expect(inner[1]!.match).toEqual([{ path: [...oidcPaths] }])
          expect(JSON.stringify(inner[1])).toContain('"handler":"oidc"')
        }
      }
    }
  })

  test("serializes the validated OIDC provider configuration", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.internalProxy], {
      oidc: caddyConfigGenerateFixtures.oidcOptions,
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.apps.oidc).toEqual({
      providers: {
        zitadel: {
          issuer: "https://auth.example",
          client_id: "test-client",
          client_secret: "test-secret",
          scope: ["openid", "email", "profile"],
          username: "email",
          authenticators: {
            authenticators: [
              {
                authenticator: "cookie",
                name: "caddy",
                secret: "0123456789abcdef0123456789abcdef",
                max_age: "168h",
                redirect_url: "/oauth2/callback",
              },
            ],
          },
        },
      },
    })
  })

  test("does not gate internal or path-scoped routes when OIDC is missing", () => {
    for (const project of [caddyConfigGenerateFixtures.internalProxy, caddyConfigGenerateFixtures.pathProxy]) {
      const result = caddyConfigGenerate([project])

      expect(result.success).toBe(true)
      if (!result.success) continue
      expect(result.data.apps.oidc).toBeUndefined()
      expect(JSON.stringify(result.data)).not.toContain('"handler":"oidc"')
      expect(JSON.stringify(result.data)).not.toContain("/private/*")
    }
  })

  test("generates the legacy static root and file server", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.static])

    expect(result.success).toBe(true)
    if (!result.success) return

    const route = routesOf(result.data)[0]!
    expect(innerRoutesOf(route)[0]!.handle).toEqual([
      {
        handler: "headers",
        response: { set: { Routed: ["static"] } },
      },
    ])
    const terminal = innerRoutesOf(route).at(-1)!
    expect(terminal.match).toBeUndefined()
    expect(terminal.handle).toEqual([{ handler: "vars", root: "/home/leo/projects/demos" }, { handler: "file_server" }])
  })

  test("preserves upstream headers and flush interval together", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxyHeaders])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    const proxy = inner.at(-1)!.handle as Array<Record<string, unknown>>
    expect(proxy[0]!.handler).toBe("reverse_proxy")
    expect(proxy[0]!.headers).toEqual({
      request: {
        set: {
          Host: ["127.0.0.1:9119"],
          Origin: ["http://127.0.0.1:9119"],
        },
      },
    })
    expect(proxy[0]!.flush_interval).toBe(-1)
  })

  test("omits flush_interval and upstream headers when the legacy defaults are absent", () => {
    const project = {
      ...caddyConfigGenerateFixtures.proxy,
      caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, flushInterval: undefined },
    }
    const result = caddyConfigGenerate([project])

    expect(result.success).toBe(true)
    if (!result.success) return

    const proxy = innerRoutesOf(routesOf(result.data)[0]!).at(-1)!.handle as Array<Record<string, unknown>>
    expect(proxy[0]!.flush_interval).toBeUndefined()
    expect(proxy[0]!.headers).toBeUndefined()
  })

  test("matches legacy Routed behavior for empty and whitespace overrides", () => {
    for (const routed of ["", "   "]) {
      const result = caddyConfigGenerate([
        {
          ...caddyConfigGenerateFixtures.proxy,
          caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, docs: false, routed },
        },
      ])

      expect(result.success).toBe(true)
      if (!result.success) continue

      const inner = innerRoutesOf(routesOf(result.data)[0]!)
      const headers = inner[0]!.handle as Array<{ response: { set: { Routed: string[] } } }>
      expect(headers[0]!.response.set.Routed).toEqual([routed])
    }
  })

  test("matches legacy docsPath behavior for empty and whitespace roots", () => {
    const cases = [
      { docsPath: "", root: "/home/leo/projects/startup/docs" },
      { docsPath: "   ", root: "   " },
    ]

    for (const { docsPath, root } of cases) {
      const result = caddyConfigGenerate([
        {
          ...caddyConfigGenerateFixtures.proxyDocs,
          caddy: { ...caddyConfigGenerateFixtures.proxyDocs.caddy, docsPath },
        },
      ])

      expect(result.success).toBe(true)
      if (!result.success) continue

      const docs = innerRoutesOf(routesOf(result.data)[0]!).filter((route) => route.group === "docs")
      const markdownHandlers = (
        docs[0]!.handle as Array<{ routes: Array<{ handle: Array<Record<string, unknown>> }> }>
      )[0]!.routes[0]!.handle
      expect(markdownHandlers[0]!.root).toBe(root)
    }
  })

  test("matches legacy browseTemplate behavior for empty and whitespace templates", () => {
    const cases = [
      { browseTemplate: "", browse: {} },
      { browseTemplate: "   ", browse: { template_file: "   " } },
    ]

    for (const { browseTemplate, browse } of cases) {
      const result = caddyConfigGenerate([
        {
          ...caddyConfigGenerateFixtures.static,
          caddy: { ...caddyConfigGenerateFixtures.static.caddy, browse: true, browseTemplate },
        },
      ])

      expect(result.success).toBe(true)
      if (!result.success) continue

      const terminal = innerRoutesOf(routesOf(result.data)[0]!).at(-1)!.handle as Array<Record<string, unknown>>
      expect(terminal[1]!.browse).toEqual(browse)
    }
  })

  test("matches legacy empty staticAllow behavior without adding a deny route", () => {
    const result = caddyConfigGenerate([
      {
        ...caddyConfigGenerateFixtures.static,
        caddy: { ...caddyConfigGenerateFixtures.static.caddy, staticAllow: [] },
      },
    ])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    expect(inner).toHaveLength(2)
    expect(inner.at(-1)!.handle).toEqual([
      { handler: "vars", root: "/home/leo/projects/demos" },
      { handler: "file_server" },
    ])
  })

  test("generates docs routes with the legacy default root and handlers", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxyDocs])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    expect(inner.map((route) => route.group ?? (route.handle ? "handle" : "match"))).toEqual([
      "handle",
      "docs",
      "docs",
      "handle",
    ])

    const docs = inner.filter((route) => route.group === "docs")
    const markdownMatch = docs[0]!.match as Array<{ path_regexp: { name: string; pattern: string } }>
    expect(markdownMatch[0]!.path_regexp).toEqual({
      name: "project_docs",
      pattern: "^/docs/((?:[A-Za-z0-9][A-Za-z0-9._-]*/)*[A-Za-z0-9][A-Za-z0-9._-]*\\.md)$",
    })
    const markdownHandlers = (docs[0]!.handle as Array<{ routes: Array<{ handle: unknown[] }> }>)[0]!.routes[0]!.handle
    expect(markdownHandlers?.[0]).toEqual({ handler: "vars", root: "/home/leo/projects/startup/docs" })
    expect(markdownHandlers?.[1]).toEqual({
      handler: "headers",
      response: {
        set: {
          "Content-Type": ["text/html; charset=utf-8"],
          "Content-Security-Policy": [
            "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'",
          ],
          "X-Content-Type-Options": ["nosniff"],
        },
      },
    })
    expect(markdownHandlers?.[2]).toEqual({ handler: "templates" })
    expect(markdownHandlers?.[3]).toMatchObject({ handler: "static_response" })

    const fallback = docs[1]!.match as Array<{ path: string[] }>
    expect(fallback[0]!.path).toEqual(["/docs", "/docs/*"])
    const fallbackHandler = (docs[1]!.handle as Array<{ routes: Array<{ handle: unknown[] }> }>)[0]!.routes[0]!.handle
    expect(fallbackHandler).toEqual([{ handler: "static_response", body: "Not found", status_code: 404 }])
  })

  test("uses an explicit docs path and the markdown template", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.staticFeatures])

    expect(result.success).toBe(true)
    if (!result.success) return

    const docs = innerRoutesOf(routesOf(result.data)[0]!).filter((route) => route.group === "docs")
    const markdownHandlers = (
      docs[0]!.handle as Array<{ routes: Array<{ handle: Array<Record<string, unknown>> }> }>
    )[0]!.routes[0]!.handle
    expect(markdownHandlers[0]!.root).toBe("/home/leo/docs/blue")
    expect(markdownHandlers[3]!.body).toContain('placeholder "http.regexp.project_docs.1"')
    expect(markdownHandlers[3]!.body).toContain("markdown (readFile $doc)")
  })

  test("applies the legacy proxy and docs defaults before route generation", () => {
    const result = caddyConfigGenerate([
      {
        schemaVersion: 1,
        owner: "leo",
        name: "defaults",
        caddy: {
          port: 4000,
          domains: ["defaults.example"],
          path: "/home/leo/projects/defaults",
        },
      },
    ])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    expect(inner.filter((route) => route.group === "docs")).toHaveLength(2)
    expect(inner.at(-1)!.handle).toEqual([
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: "localhost:4000" }],
      },
    ])
  })

  test("preserves browse defaults and custom browse templates", () => {
    const defaultBrowse = {
      ...caddyConfigGenerateFixtures.static,
      caddy: { ...caddyConfigGenerateFixtures.static.caddy, browse: true },
    }
    const defaultResult = caddyConfigGenerate([defaultBrowse])
    expect(defaultResult.success).toBe(true)
    if (!defaultResult.success) return

    const defaultTerminal = innerRoutesOf(routesOf(defaultResult.data)[0]!).at(-1)!.handle as Array<
      Record<string, unknown>
    >
    expect(defaultTerminal[1]!.browse).toEqual({})

    const customResult = caddyConfigGenerate([caddyConfigGenerateFixtures.staticFeatures])
    expect(customResult.success).toBe(true)
    if (!customResult.success) return

    const customTerminal = innerRoutesOf(routesOf(customResult.data)[0]!).at(-1)!.handle as Array<
      Record<string, unknown>
    >
    expect(customTerminal[2]!.browse).toEqual({ template_file: "/home/leo/templates/browse.html" })
  })

  test("keeps dotfile denial and static allowlist before the static terminal route", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.staticFeatures])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    expect(inner[3]).toEqual({
      match: [{ path_regexp: { pattern: "^/\\..*" } }],
      handle: [{ handler: "static_response", body: "Not found", status_code: 404 }],
    })
    expect(inner[4]).toEqual({
      match: [{ not: [{ path: ["/README.md"] }, { path: ["/data/*"] }] }],
      handle: [
        {
          handler: "static_response",
          body: "Only markdown and YAML files are accessible",
          status_code: 403,
        },
      ],
    })
    expect(inner[5]!.match).toEqual([
      {
        file: {
          root: "/home/leo/projects/blue",
          try_files: ["{http.request.uri.path}", "/index.html"],
        },
      },
    ])
  })

  test("adds the explicit Routed response value without changing static handler order", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.staticFeatures])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    expect(inner[0]!.handle).toEqual([
      {
        handler: "headers",
        response: { set: { Routed: ["blue-static"] } },
      },
    ])
    expect((inner.at(-1)!.handle as Array<Record<string, unknown>>).map((handler) => handler.handler)).toEqual([
      "vars",
      "rewrite",
      "file_server",
    ])
  })

  test("does not add SPA matchers or rewrites to non-SPA static projects", () => {
    const result = caddyConfigGenerate([caddyConfigGenerateFixtures.static])

    expect(result.success).toBe(true)
    if (!result.success) return

    const terminal = innerRoutesOf(routesOf(result.data)[0]!).at(-1)!
    expect(terminal.match).toBeUndefined()
    expect(JSON.stringify(terminal)).not.toContain("try_files")
    expect(JSON.stringify(terminal)).not.toContain('"handler":"rewrite"')
  })

  test("skips docs routes when docs are enabled but no docs root exists", () => {
    const project = {
      ...caddyConfigGenerateFixtures.proxyDocs,
      caddy: { ...caddyConfigGenerateFixtures.proxyDocs.caddy, path: "" },
    }
    const result = caddyConfigGenerate([project])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    expect(inner.some((route) => route.group === "docs")).toBe(false)
  })

  test("rejects a static project without a root path", () => {
    const project = {
      ...caddyConfigGenerateFixtures.static,
      caddy: { ...caddyConfigGenerateFixtures.static.caddy, path: "" },
    }
    const result = caddyConfigGenerate([project])

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("static project requires path")
  })

  test("returns failed Results for null and malformed projects without throwing", () => {
    const malformedProjects: unknown[] = [
      null,
      {},
      [null],
      [{ ...caddyConfigGenerateFixtures.proxy, caddy: "invalid" }],
    ]

    for (const projects of malformedProjects) {
      let result: ReturnType<typeof caddyConfigGenerate> | undefined
      expect(() => {
        result = caddyConfigGenerate(projects)
      }).not.toThrow()
      expect(result?.success).toBe(false)
    }
  })

  test("returns failed Results for null and malformed options without throwing", () => {
    const malformedOptions: unknown[] = [null, { httpsListener: 8443 }, { httpsListener: ":0" }, { unexpected: true }]

    for (const options of malformedOptions) {
      let result: ReturnType<typeof caddyConfigGenerate> | undefined
      expect(() => {
        result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], options)
      }).not.toThrow()
      expect(result?.success).toBe(false)
    }
  })

  test("returns a sanitized failed Result for a throwing project getter", () => {
    const project = {
      ...caddyConfigGenerateFixtures.proxy,
      caddy: {
        ...caddyConfigGenerateFixtures.proxy.caddy,
        get headerUp(): Record<string, string> {
          throw new Error("secret project getter")
        },
      },
    }

    let result: ReturnType<typeof caddyConfigGenerate> | undefined
    expect(() => {
      result = caddyConfigGenerate([project])
    }).not.toThrow()
    expect(result?.success).toBe(false)
    if (!result || result.success) return
    expect(result.errorMessage).toBe("invalid Caddy generation input")
    expect(result.errorMessage).not.toContain("secret project getter")
  })

  test("returns a sanitized failed Result for a throwing options proxy", () => {
    const options = new Proxy(
      { httpsListener: ":8443" },
      {
        ownKeys() {
          throw new Error("secret options proxy")
        },
      },
    )

    let result: ReturnType<typeof caddyConfigGenerate> | undefined
    expect(() => {
      result = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], options)
    }).not.toThrow()
    expect(result?.success).toBe(false)
    if (!result || result.success) return
    expect(result.errorMessage).toBe("invalid Caddy generation input")
    expect(result.errorMessage).not.toContain("secret options proxy")
  })

  test("preserves reserved upstream header names without prototype pollution", () => {
    const inherited = { inherited: "drop", polluted: "drop" }
    const headerUp = Object.create(inherited) as Record<string, string>
    headerUp.Host = "good"
    Object.defineProperty(headerUp, "constructor", { enumerable: true, value: "constructor-value" })
    Object.defineProperty(headerUp, "prototype", { enumerable: true, value: "prototype-value" })
    Object.defineProperty(headerUp, "__proto__", { enumerable: true, value: "dunder-value" })

    const result = caddyConfigGenerate([
      {
        ...caddyConfigGenerateFixtures.proxy,
        caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, docs: false, headerUp },
      },
    ])

    expect(result.success).toBe(true)
    if (!result.success) return

    const inner = innerRoutesOf(routesOf(result.data)[0]!)
    const proxy = inner.at(-1)!.handle as Array<Record<string, unknown>>
    const set = (proxy[0]!.headers as { request: { set: Record<string, string[]> } }).request.set
    expect(Object.keys(set)).toEqual(["Host", "constructor", "prototype", "__proto__"])
    expect(set).toEqual(
      Object.fromEntries([
        ["Host", ["good"]],
        ["constructor", ["constructor-value"]],
        ["prototype", ["prototype-value"]],
        ["__proto__", ["dunder-value"]],
      ]),
    )
    expect(Object.getPrototypeOf(set)).toBe(Object.prototype)
    expect("inherited" in set).toBe(false)
    expect("polluted" in set).toBe(false)
  })
})
