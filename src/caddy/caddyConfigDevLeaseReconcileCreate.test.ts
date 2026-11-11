import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { DevLeaseRecord } from "../dev/devLeaseRecordSchema.js"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import { caddyConfigHostnames } from "./caddyConfigHostnames.js"
import { caddyConfigSerialize } from "./caddyConfigSerialize.js"
import type { CaddyConfig } from "./CaddyConfig.js"
import { caddyConfigDevLeaseReconcileCreate } from "./caddyConfigDevLeaseReconcileCreate.js"

function leaseCreate(overrides: Partial<DevLeaseRecord> & { name: string }): DevLeaseRecord {
  const { name, ...rest } = overrides
  return {
    projectKey: { owner: "tim", name },
    user: "tim",
    port: 4400,
    unit: `dev-tim-${name}.service`,
    hostname: `tim-${name}.wonder1.de`,
    state: "active",
    ttlMs: 14_400_000,
    lastSeenAt: 0,
    createdAt: 0,
    ...rest,
  }
}

function generatedConfig(): CaddyConfig {
  const generatedR = caddyConfigGenerate([], { networkVisibility: "private" })
  if (!generatedR.success) throw new Error(generatedR.errorMessage)
  return generatedR.data
}

describe("caddyConfigDevLeaseReconcileCreate", () => {
  test("returns the input unchanged while disabled", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: false,
      leasesCurrent: async () => createResult([leaseCreate({ name: "akademie" })]),
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const input = generatedConfig()
    const result = await reconcileR.data(input, [])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe(input)
  })

  test("an empty lease table keeps the generated config byte-identical", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () => createResult([]),
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const input = generatedConfig()
    const result = await reconcileR.data(input, [])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe(input)
    const before = caddyConfigSerialize(input)
    const after = caddyConfigSerialize(result.data)
    expect(before.success && after.success && before.data === after.data).toBe(true)
  })

  test("one active lease adds exactly its private reverse-proxy route", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () =>
        createResult([
          leaseCreate({ name: "akademie" }),
          leaseCreate({ name: "werkstatt", state: "starting", port: 4401, hostname: "tim-werkstatt.wonder1.de" }),
        ]),
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const result = await reconcileR.data(generatedConfig(), [])
    expect(result.success).toBe(true)
    if (!result.success) return
    const routes = result.data.apps.http.servers.srv0.routes
    expect(routes).toHaveLength(1)
    const route = routes[0] as Record<string, unknown>
    expect(route.match).toEqual([{ host: ["tim-akademie.wonder1.de"] }])
    expect(route.terminal).toBe(true)
    const serialized = JSON.stringify(route)
    expect(serialized).toContain("127.0.0.1:4400")
    expect(serialized).not.toContain("localhost:")
    expect(serialized).toContain("tim-akademie")
    // Starting leases get no route: only healthy active leases are served.
    expect(serialized).not.toContain("werkstatt")
    // The post-merge hostname guard in the Caddy application scans match.host,
    // so lease routes stay visible to conflict detection.
    expect(caddyConfigHostnames(result.data)).toEqual(["tim-akademie.wonder1.de"])
  })

  test("lease routes sort by hostname for a deterministic config", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () => createResult([leaseCreate({ name: "werkstatt" }), leaseCreate({ name: "akademie" })]),
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const result = await reconcileR.data(generatedConfig(), [])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(caddyConfigHostnames(result.data)).toEqual(["tim-akademie.wonder1.de", "tim-werkstatt.wonder1.de"])
  })

  test("an unreadable lease table fails the regenerate instead of dropping routes silently", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () => ({ success: false as const, op: "test", errorMessage: "sidecar unreadable" }),
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const result = await reconcileR.data(generatedConfig(), [])
    expect(result.success).toBe(false)
  })

  test("emits the shared dev-lease logger with host mapping when a root is configured", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () =>
        createResult([
          leaseCreate({ name: "akademie" }),
          leaseCreate({ name: "werkstatt", state: "starting", port: 4401, hostname: "tim-werkstatt.wonder1.de" }),
        ]),
      accessLogRoot: "/var/lib/project-registry/caddy-access-logs",
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const result = await reconcileR.data(generatedConfig(), [])
    expect(result.success).toBe(true)
    if (!result.success) return
    const routes = result.data.apps.http.servers.srv0.routes
    expect(routes).toHaveLength(1)

    const logs = result.data.logging?.logs as Record<string, Record<string, unknown>>
    expect(logs["dev-leases"]).toMatchObject({
      encoder: { format: "json" },
      include: ["http.log.access.dev-leases"],
      writer: {
        output: "file",
        filename: "/var/lib/project-registry/caddy-access-logs/dev-leases/access.jsonl",
        mode: "0600",
        dir_mode: "0700",
        roll_size_mb: 25,
        roll_keep: 1,
        roll_keep_days: 14,
      },
    })
    expect(logs.default).toEqual({ exclude: ["http.log.access.dev-leases"] })
    expect(result.data.apps.http.servers.srv0.logs).toEqual({
      logger_names: { "tim-akademie.wonder1.de": ["dev-leases"] },
      should_log_credentials: true,
    })
    expect(JSON.stringify(result.data)).not.toContain("werkstatt")
  })

  test("an empty lease table emits no logger even with a root configured", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () => createResult([]),
      accessLogRoot: "/var/lib/project-registry/caddy-access-logs",
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const input = generatedConfig()
    const result = await reconcileR.data(input, [])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe(input)
  })

  test("active leases without a root emit routes only and stay free of logging keys", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () => createResult([leaseCreate({ name: "akademie" })]),
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const result = await reconcileR.data(generatedConfig(), [])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.apps.http.servers.srv0.routes).toHaveLength(1)
    expect(result.data.logging).toBeUndefined()
    expect(result.data.apps.http.servers.srv0.logs).toBeUndefined()
    expect(JSON.stringify(result.data)).not.toContain("dev-leases")
  })

  test("merges the dev logger with existing project logging instead of replacing it", async () => {
    const withProjectLogs = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], {
      caddyAccessLogRoot: "/var/lib/project-registry/caddy-access-logs",
    })
    expect(withProjectLogs.success).toBe(true)
    if (!withProjectLogs.success) return
    const projectLoggerNames = withProjectLogs.data.apps.http.servers.srv0.logs?.logger_names ?? {}
    expect(Object.keys(projectLoggerNames)).not.toHaveLength(0)

    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () => createResult([leaseCreate({ name: "akademie" })]),
      accessLogRoot: "/var/lib/project-registry/caddy-access-logs",
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const result = await reconcileR.data(withProjectLogs.data, [])
    expect(result.success).toBe(true)
    if (!result.success) return
    const logs = result.data.logging?.logs as Record<string, unknown>
    expect(Object.keys(logs).sort()).toEqual(
      [...Object.keys(withProjectLogs.data.logging?.logs ?? {}), "dev-leases"].sort(),
    )
    const loggerNames = result.data.apps.http.servers.srv0.logs?.logger_names ?? {}
    expect(loggerNames["tim-akademie.wonder1.de"]).toEqual(["dev-leases"])
    for (const [domain, names] of Object.entries(projectLoggerNames)) {
      expect(loggerNames[domain]).toEqual(names)
    }
    const exclude = (logs.default as { exclude: string[] }).exclude
    const inputLogs = withProjectLogs.data.logging?.logs as Record<string, { exclude?: string[] }> | undefined
    const inputExclude = inputLogs?.default?.exclude ?? []
    expect(exclude).toContain("http.log.access.dev-leases")
    expect(exclude).toHaveLength(inputExclude.length + 1)
  })

  test("an invalid access log root fails the regenerate instead of emitting routes without a logger", async () => {
    const reconcileR = caddyConfigDevLeaseReconcileCreate({
      enabled: true,
      leasesCurrent: async () => createResult([leaseCreate({ name: "akademie" })]),
      accessLogRoot: "",
    })
    expect(reconcileR.success).toBe(true)
    if (!reconcileR.success) return

    const result = await reconcileR.data(generatedConfig(), [])
    expect(result.success).toBe(false)
  })
})
