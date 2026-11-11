import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { DevLeaseRecord } from "../dev/devLeaseRecordSchema.js"
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
})
