import { describe, expect, test } from "bun:test"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import { caddyConfigBaseMerge } from "./caddyConfigBaseMerge.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import type { CaddyJsonObject } from "./caddyJsonObjectSchema.js"

function route(hosts: string[], target = "localhost:4000") {
  return {
    match: [{ host: hosts }],
    handle: [
      { handler: "subroute", routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: target }] }] }] },
    ],
    terminal: true,
  }
}

function config(routes: unknown[] = [], serverName = "srv0") {
  return { apps: { http: { servers: { [serverName]: { listen: [":443"], routes } } } } }
}

function serverOf(value: CaddyJsonObject, name = "srv0"): CaddyJsonObject {
  const apps = value.apps as CaddyJsonObject
  const http = apps.http as CaddyJsonObject
  return (http.servers as CaddyJsonObject)[name] as CaddyJsonObject
}

function routesOf(value: CaddyJsonObject, name = "srv0"): unknown[] {
  return serverOf(value, name).routes as unknown[]
}

function customConfig() {
  const custom = {
    ...route(["manual.dev", "manual.example"]),
    handle: [
      {
        handler: "subroute",
        routes: [
          { handle: [{ handler: "encode", encodings: { zstd: {}, gzip: {} }, prefer: ["zstd", "gzip"] }] },
          { group: "private", match: [{ path: ["/private/*"] }], handle: [{ handler: "oidc", provider: "existing" }] },
          {
            group: "files",
            match: [{ not: [{ path: ["/README.md", "/assets/*"] }] }],
            handle: [
              {
                handler: "subroute",
                routes: [{ terminal: true, handle: [{ handler: "static_response", status_code: 403 }] }],
              },
            ],
          },
          {
            handle: [
              { handler: "vars", root: "/srv/manual" },
              { handler: "file_server", browse: {} },
            ],
          },
        ],
      },
    ],
  }
  return {
    admin: { listen: "unix//run/user/1000/caddy.sock", config: { persist: false } },
    storage: { module: "file_system", root: "/private/caddy" },
    logging: {
      logs: {
        default: { exclude: ["http.log.access.log0"] },
        log0: { writer: { output: "stdout" }, include: ["http.log.access.log0"] },
      },
    },
    apps: {
      pki: { certificate_authorities: { local: { name: "Existing CA" } } },
      oidc: { providers: { existing: { issuer: "https://auth.example" } } },
      tls: {
        automation: { policies: [{ subjects: ["manual.dev"], on_demand: true, disable_ocsp_stapling: true }] },
        certificates: {
          load_files: [{ certificate: "/certs/local.pem", key: "/certs/local-key.pem", tags: ["cert0"] }],
          load_pem: [{ certificate: "existing certificate", key: "existing key" }],
        },
        disable_ocsp_stapling: true,
      },
      http: {
        grace_period: "10s",
        servers: {
          srv0: {
            listen: [":443"],
            automatic_https: {},
            tls_connection_policies: [
              { match: { sni: ["manual.dev"] }, certificate_selection: { any_tag: ["cert0"] } },
              {},
            ],
            logs: { logger_names: { "manual.dev": ["log0"] } },
            protocols: ["h1", "h2"],
            routes: [custom, route(["untouched.dev"])],
          },
          other: { listen: [":8080"], routes: [route(["other.dev"])] },
        },
      },
    },
  }
}

describe("caddyConfigBaseMerge", () => {
  test("without a base preserves actual generated root-mode JSON including OIDC and logging", () => {
    const generated = caddyConfigGenerate([caddyConfigGenerateFixtures.internalProxy], {
      oidc: caddyConfigGenerateFixtures.oidcOptions,
      caddyAccessLogRoot: "/var/log/project-registry",
    })
    expect(generated.success).toBe(true)
    if (!generated.success) return
    const merged = caddyConfigBaseMerge(generated.data)
    expect(merged.success).toBe(true)
    if (!merged.success) return
    expect<unknown>(merged.data).toEqual(generated.data)
    expect(merged.data).not.toBe(generated.data)
  })

  test("appends new generated hosts while preserving nested custom sites and full base policies", () => {
    const base = customConfig()
    const original = structuredClone(base)
    const generated = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy])
    expect(generated.success).toBe(true)
    if (!generated.success) return
    const result = caddyConfigBaseMerge(generated.data, { baseConfig: base })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(routesOf(result.data).slice(0, 2)).toEqual(base.apps.http.servers.srv0.routes)
    expect(routesOf(result.data).slice(2)).toEqual(generated.data.apps.http.servers.srv0.routes)
    const expected = structuredClone(base)
    expected.apps.http.servers.srv0.routes.push(
      ...(generated.data.apps.http.servers.srv0.routes as typeof expected.apps.http.servers.srv0.routes),
    )
    expect<unknown>(result.data).toEqual(expected)
    const tls = (result.data.apps as CaddyJsonObject).tls as CaddyJsonObject
    const certificates = tls.certificates as CaddyJsonObject
    ;(certificates.load_files as unknown[]).push({ certificate: "/new/local.pem", key: "/new/local-key.pem" })
    expect(tls.automation).toEqual(base.apps.tls.automation)
    expect((certificates.load_files as unknown[])[0]).toEqual(base.apps.tls.certificates.load_files[0])
    expect(certificates.load_pem).toEqual(base.apps.tls.certificates.load_pem)
    expect(base).toEqual(original)
  })

  test("explicit ownership replaces in place, deletes missing hosts and appends additions deterministically", () => {
    const first = route(["first.dev"])
    const last = route(["last.dev"])
    const base = config([first, route(["replace.dev"]), route(["delete.dev"]), last])
    const replacement = route(["replace.dev"], "localhost:9000")
    const addition = route(["new.dev"])
    const generated = config([addition, replacement])
    const original = structuredClone({ base, generated })
    const result = caddyConfigBaseMerge(generated, { baseConfig: base, managedHosts: ["replace.dev", "delete.dev"] })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(routesOf(result.data)).toEqual([first, replacement, last, addition])
    expect({ base, generated }).toEqual(original)
    expect(
      caddyConfigBaseMerge(generated, {
        baseConfig: result.data,
        managedHosts: ["replace.dev", "delete.dev", "new.dev"],
      }),
    ).toEqual(result)
  })

  test("without ownership refuses to rewrite imported routes even when generated JSON is identical", () => {
    const generated = config([route(["manual.dev"])])
    const result = caddyConfigBaseMerge(generated, { baseConfig: generated })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("unowned")
  })

  test("rejects deleting or replacing a multi-host shared base route even if all hosts are managed", () => {
    for (const generated of [config(), config([route(["a.dev"]), route(["b.dev"])])]) {
      const result = caddyConfigBaseMerge(generated, {
        baseConfig: config([route(["a.dev", "b.dev"])]),
        managedHosts: ["a.dev", "b.dev"],
      })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.errorMessage).toContain("shared")
    }
  })

  test("rejects duplicates, wildcard overlap, conditional/OR overlap, groups and terminal changes", () => {
    const bases = [
      config([route(["a.dev"]), route(["a.dev"])]),
      config([route(["*.dev"])]),
      config([{ ...route(["a.dev"]), match: [{ host: ["a.dev"], path: ["/private/*"] }] }]),
      config([{ ...route(["a.dev"]), match: [{ host: ["a.dev"] }, { host: ["b.dev"] }] }]),
      config([{ ...route(["a.dev"]), group: "shared" }]),
      config([{ ...route(["a.dev"]), terminal: false }]),
    ]
    for (const base of bases) {
      expect(
        caddyConfigBaseMerge(config([route(["a.dev"])]), { baseConfig: base, managedHosts: ["a.dev"] }).success,
      ).toBe(false)
    }
  })

  test("rejects hostless terminal fallbacks and nested host wrappers instead of reordering them", () => {
    const catchalls = [
      { terminal: true, handle: [{ handler: "static_response", status_code: 404 }] },
      { handle: [{ handler: "subroute", routes: [route(["nested.dev"])] }] },
      { match: [{ not: [{ host: ["except.dev"] }] }], handle: [{ handler: "static_response" }] },
      { ...route(["a.dev"]), match: [{ host: ["a.dev"] }, { path: ["/anything"] }] },
    ]
    for (const catchall of catchalls) {
      expect(caddyConfigBaseMerge(config([route(["new.dev"])]), { baseConfig: config([catchall]) }).success).toBe(false)
    }
  })

  test("does not infer a target server and rejects overlap on another listener", () => {
    const base = config([route(["a.dev"])], "imported")
    expect(caddyConfigBaseMerge(config([route(["new.dev"])]), { baseConfig: base }).success).toBe(false)
    const result = caddyConfigBaseMerge(config([route(["new.dev"])]), {
      baseConfig: base,
      targetServerName: "imported",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(routesOf(result.data, "imported")).toEqual([route(["a.dev"]), route(["new.dev"])])
    const cross = customConfig()
    expect(
      caddyConfigBaseMerge(config([route(["other.dev"])]), { baseConfig: cross, managedHosts: ["other.dev"] }).success,
    ).toBe(false)
  })

  test("normalizes exact host identity and rejects unsupported generated host or group shapes", () => {
    const replacement = route(["a.dev"])
    expect(
      caddyConfigBaseMerge(config([replacement]), { baseConfig: config([route(["A.DEV."])]), managedHosts: ["A.DEV."] })
        .success,
    ).toBe(true)
    for (const invalid of [
      route(["*.dev"]),
      route(["{http.request.host}"]),
      route(["A.DEV", "a.dev"]),
      { ...route(["a.dev"]), group: "shared" },
    ]) {
      expect(caddyConfigBaseMerge(config([invalid]), { baseConfig: config() }).success).toBe(false)
    }
  })

  test("adds missing auth dependencies but refuses conflicting TLS, logging, listeners or admin policies", () => {
    const base = customConfig()
    const generated = {
      ...config([route(["new.dev"])]),
      apps: {
        ...config([route(["new.dev"])]).apps,
        oidc: { providers: { registry: { issuer: "https://new-auth.example" } } },
      },
    }
    const result = caddyConfigBaseMerge(generated, { baseConfig: base })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect((result.data.apps as CaddyJsonObject).oidc).toEqual({
      providers: { ...base.apps.oidc.providers, ...generated.apps.oidc.providers },
    })
    const conflicts = [
      {
        ...config(),
        apps: {
          ...config().apps,
          tls: { certificates: { load_files: [{ certificate: "/new.pem", key: "/new.key" }] } },
        },
      },
      { ...config(), logging: { logs: { default: { exclude: ["new-log"] } } } },
      { apps: { http: { servers: { srv0: { listen: [":8443"], routes: [] } } } } },
      { ...config(), admin: { listen: "localhost:2019" } },
    ]
    for (const conflict of conflicts) {
      const rejected = caddyConfigBaseMerge(conflict, { baseConfig: base })
      expect(rejected.success).toBe(false)
      if (rejected.success) continue
      expect(rejected.errorMessage).toContain("Conflicting generated configuration")
    }
  })

  test("with no affected hosts returns full opaque base unchanged and rejects malformed JSON/options", () => {
    const base = customConfig()
    expect<unknown>(caddyConfigBaseMerge(config(), { baseConfig: base })).toEqual({ success: true, data: base })
    for (const [generated, options] of [
      [null, {}],
      [config(), { baseConfig: null }],
      [config(), { baseConfig: {}, managedHosts: ["*.dev"] }],
      [config(), { unexpected: true }],
      [config(), { baseConfig: { apps: { http: { servers: { srv0: { routes: "invalid" } } } } } }],
      [{ ...config(), notJson: undefined }, {}],
    ])
      expect(caddyConfigBaseMerge(generated, options).success).toBe(false)
  })
})
