import { describe, expect, test } from "bun:test"
import type { Project } from "../project/Project.js"
import { projectPrivateTlsGateStateCreate } from "../project/projectPrivateTlsGate.js"
import type { CaddyConfig } from "./CaddyConfig.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import { caddyConfigPrivateTlsReconcileCreate } from "./caddyConfigPrivateTlsReconcile.js"

function project(
  name: string,
  domains: string[],
  owner = "leo",
  networkVisibility: "public" | "private" = "private",
): Project {
  return {
    schemaVersion: 2,
    owner,
    name,
    order: 0,
    services: [
      {
        id: "default",
        units: [],
        ownership: "registry",
        caddy: {
          port: 4300,
          domains,
          path: "/srv/app",
          access: "external",
          kind: "proxy",
          docs: false,
          browse: false,
          headerUp: {},
          disabled: false,
          denyDotfiles: false,
          spa: false,
          networkVisibility,
        },
      },
    ],
    labels: {},
  }
}

function generatePrivate(projects: Project[]): CaddyConfig {
  const generated = caddyConfigGenerate(projects, { networkVisibility: "private" })
  if (!generated.success) throw new Error(`setup failed: ${generated.errorMessage}`)
  return generated.data
}

function routeHosts(config: CaddyConfig): string[][] {
  return config.apps.http.servers.srv0.routes.map((route) => {
    const match = (route as { match?: Array<{ host?: string[] }> }).match ?? []
    return match.flatMap((matcher) => matcher.host ?? [])
  })
}

describe("caddyConfigPrivateTlsReconcileCreate", () => {
  test("returns the config unchanged while disabled", async () => {
    const projects = [project("app", ["api.preview.wonder1.de"])]
    const config = generatePrivate(projects)
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: false,
      snapshotCurrent: () => ({ enrolled: [], wildcardCovered: [], proven: [] }),
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return
    const reconciled = await reconcileR.data(config, projects)
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    expect(reconciled.data).toBe(config)
  })

  test("leaves configs without private names untouched", async () => {
    const publicProject = project("web", ["shop.example.com"], "leo", "public")
    const config = generatePrivate([publicProject])
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({ enrolled: [], wildcardCovered: [], proven: [] }),
    })
    if (!reconcileR.success) throw new Error("setup failed")
    const reconciled = await reconcileR.data(config, [publicProject])
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    expect(reconciled.data).toBe(config)
  })

  test("enrolls on the zero-route baseline first: tls installed while unproven routes are withheld", async () => {
    const projects = [project("app", ["api.preview.wonder1.de"]), project("shop", ["checkout.wonder1.de"])]
    const config = generatePrivate(projects)
    expect(config.apps.http.servers.srv0.routes).toHaveLength(2)
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({
        enrolled: ["api.preview.wonder1.de"],
        wildcardCovered: ["checkout.wonder1.de"],
        proven: [],
      }),
    })
    if (!reconcileR.success) throw new Error("setup failed")
    const reconciled = await reconcileR.data(config, projects)
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    expect(reconciled.data.apps.http.servers.srv0.routes).toEqual([])
    expect(reconciled.data.apps.tls?.certificates?.automate).toEqual(["api.preview.wonder1.de"])
    expect(reconciled.data.apps.tls?.automation?.policies).toHaveLength(1)
    expect(reconciled.data.apps.tls?.automation?.policies?.[0]?.subjects).toEqual(["api.preview.wonder1.de"])
    // The input config is never mutated.
    expect(config.apps.http.servers.srv0.routes).toHaveLength(2)
    expect(config.apps.tls).toBeUndefined()
  })

  test("serves routes once their enrollment is proven", async () => {
    const projects = [project("app", ["api.preview.wonder1.de"]), project("shop", ["checkout.wonder1.de"])]
    const config = generatePrivate(projects)
    const gate = projectPrivateTlsGateStateCreate({
      enrolled: ["api.preview.wonder1.de"],
      wildcardCovered: ["checkout.wonder1.de"],
      proven: ["api.preview.wonder1.de", "checkout.wonder1.de"],
    })
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({ enabled: true, snapshotCurrent: gate.current })
    if (!reconcileR.success) throw new Error("setup failed")
    const reconciled = await reconcileR.data(config, projects)
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    expect(routeHosts(reconciled.data)).toEqual([["api.preview.wonder1.de"], ["checkout.wonder1.de"]])
    expect(reconciled.data.apps.tls?.certificates?.automate).toEqual(["api.preview.wonder1.de"])
  })

  test("withholds a whole route when any of its names is unproven", async () => {
    const projects = [project("app", ["api.preview.wonder1.de", "cms.preview.wonder1.de"])]
    const config = generatePrivate(projects)
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({
        enrolled: ["api.preview.wonder1.de", "cms.preview.wonder1.de"],
        wildcardCovered: [],
        proven: ["api.preview.wonder1.de"],
      }),
    })
    if (!reconcileR.success) throw new Error("setup failed")
    const reconciled = await reconcileR.data(config, projects)
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    expect(reconciled.data.apps.http.servers.srv0.routes).toEqual([])
    expect(reconciled.data.apps.tls?.certificates?.automate).toEqual([
      "api.preview.wonder1.de",
      "cms.preview.wonder1.de",
    ])
  })

  test("unions onto base TLS and refuses overlapping subjects", async () => {
    const projects = [project("app", ["api.preview.wonder1.de"])]
    const generated = generatePrivate(projects)
    const withBase: CaddyConfig = {
      ...generated,
      apps: {
        ...generated.apps,
        tls: {
          automation: {
            policies: [{ subjects: ["*.wonder1.de"], issuers: [{ module: "acme" }] }],
          },
          certificates: { automate: ["*.wonder1.de"] },
        },
      },
    }
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({
        enrolled: ["api.preview.wonder1.de"],
        wildcardCovered: [],
        proven: ["api.preview.wonder1.de"],
      }),
    })
    if (!reconcileR.success) throw new Error("setup failed")
    const reconciled = await reconcileR.data(withBase, projects)
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    expect(reconciled.data.apps.tls?.automation?.policies?.map((policy) => policy.subjects)).toEqual([
      ["*.wonder1.de"],
      ["api.preview.wonder1.de"],
    ])
    expect(reconciled.data.apps.tls?.certificates?.automate).toEqual(["*.wonder1.de", "api.preview.wonder1.de"])
    expect(routeHosts(reconciled.data)).toEqual([["api.preview.wonder1.de"]])

    const overlapping: CaddyConfig = {
      ...generated,
      apps: {
        ...generated.apps,
        tls: {
          automation: { policies: [{ subjects: ["api.preview.wonder1.de"], issuers: [] }] },
          certificates: { automate: [] },
        },
      },
    }
    const refused = await reconcileR.data(overlapping, projects)
    expect(refused.success).toBe(false)
    if (refused.success) return
    expect(refused.errorMessage).toContain("api.preview.wonder1.de")

    const malformed: CaddyConfig = {
      ...generated,
      apps: { ...generated.apps, tls: { automation: { policies: "nope" } } as unknown as CaddyConfig["apps"]["tls"] },
    }
    expect((await reconcileR.data(malformed, projects)).success).toBe(false)
  })

  test("passes legacy and unparseable routes through while gating desired names", async () => {
    const projects = [project("app", ["api.preview.wonder1.de"])]
    const generated = generatePrivate(projects)
    const legacyRoute = {
      match: [{ host: ["legacy.wonder1.de"] }],
      handle: [{ handler: "static_response", body: "legacy" }],
    }
    const unparseableRoute = { handle: [{ handler: "static_response", body: "no-match" }] }
    const mixed: CaddyConfig = {
      ...generated,
      apps: {
        ...generated.apps,
        http: {
          servers: {
            srv0: {
              ...generated.apps.http.servers.srv0,
              routes: [legacyRoute, unparseableRoute, ...generated.apps.http.servers.srv0.routes],
            },
          },
        },
      },
    }
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({ enrolled: [], wildcardCovered: [], proven: [] }),
    })
    if (!reconcileR.success) throw new Error("setup failed")
    const reconciled = await reconcileR.data(mixed, projects)
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    expect(reconciled.data.apps.http.servers.srv0.routes).toEqual([legacyRoute, unparseableRoute])
  })

  test("fails closed on unenrollable claims, listener resolvers, and missing snapshots", async () => {
    const unbound = [project("app", ["api.preview.webflows.de"], "fabian")]
    const unboundConfig = generatePrivate(unbound)
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({ enrolled: [], wildcardCovered: [], proven: [] }),
    })
    if (!reconcileR.success) throw new Error("setup failed")
    const unboundR = await reconcileR.data(unboundConfig, unbound)
    expect(unboundR.success).toBe(false)
    if (unboundR.success) return
    expect(unboundR.errorMessage).toContain('owner "fabian"')

    const projects = [project("app", ["api.preview.wonder1.de"])]
    const config = generatePrivate(projects)
    const listenerR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({ enrolled: [], wildcardCovered: [], proven: [] }),
      resolvers: ["100.122.200.114"],
      privateListenerAddresses: ["100.122.200.114"],
    })
    if (!listenerR.success) throw new Error("setup failed")
    expect((await listenerR.data(config, projects)).success).toBe(false)

    const blindR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => {
        throw new Error("gone")
      },
    })
    if (!blindR.success) throw new Error("setup failed")
    const blind = await blindR.data(config, projects)
    expect(blind.success).toBe(false)
    if (blind.success) return
    expect(blind.errorMessage).toContain("snapshot")

    expect(
      caddyConfigPrivateTlsReconcileCreate({ enabled: "yes" as never, snapshotCurrent: () => ({}) as never }).success,
    ).toBe(false)
  })

  test("never embeds token literals in the rendered config", async () => {
    const projects = [project("app", ["api.preview.wonder1.de"])]
    const config = generatePrivate(projects)
    const reconcileR = caddyConfigPrivateTlsReconcileCreate({
      enabled: true,
      snapshotCurrent: () => ({
        enrolled: ["api.preview.wonder1.de"],
        wildcardCovered: [],
        proven: ["api.preview.wonder1.de"],
      }),
    })
    if (!reconcileR.success) throw new Error("setup failed")
    const reconciled = await reconcileR.data(config, projects)
    expect(reconciled.success).toBe(true)
    if (!reconciled.success) return
    const serialized = JSON.stringify(reconciled.data)
    expect(serialized).toContain("{env.CLOUDFLARE_API_TOKEN}")
    expect(serialized).not.toContain("cf-test-token")
  })
})
