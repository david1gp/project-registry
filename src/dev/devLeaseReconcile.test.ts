import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import { devLeaseReconcile } from "./devLeaseReconcile.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"
import type { DevLeaseTrackingState } from "./devLeaseTrackingState.js"

type RunnerCall = { command: string; args: readonly string[] }

function trackingCreate(initial: DevLeaseRecord[]): DevLeaseTracking & { state: DevLeaseTrackingState } {
  const value = {
    state: { version: 1 as const, leases: initial },
    read: async () => createResult(value.state),
    write: async (next: DevLeaseTrackingState) => {
      value.state = next
      return createResult(undefined)
    },
  }
  return value
}

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
    lastSeenAt: 5_000,
    createdAt: 0,
    ...rest,
  }
}

function runnerCreate(calls: RunnerCall[], aliveUnits: readonly string[]): DevProcessRunner {
  return async (command, args, input) => {
    calls.push({ command, args })
    void input
    if (command === "systemctl" && args[0] === "is-active") {
      const unit = args[1] ?? ""
      return createResult({
        exitCode: aliveUnits.includes(unit) ? 0 : 3,
        stdout: aliveUnits.includes(unit) ? "active\n" : "inactive\n",
        stderr: "",
      })
    }
    return createResult({ exitCode: 0, stdout: "", stderr: "" })
  }
}

describe("devLeaseReconcile", () => {
  test("default reconciliation keeps idle live leases and activates a live starting lease", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([
      leaseCreate({ name: "old", lastSeenAt: 0, ttlMs: 1000 }),
      leaseCreate({ name: "starting", state: "starting", lastSeenAt: 0, ttlMs: 1000 }),
    ])
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate(calls, ["dev-tim-old.service", "dev-tim-starting.service"]),
      clock: () => 5000,
    })
    expect(result).toEqual({ success: true, data: { changed: true, removed: 0, activated: 1, touched: 0 } })
    expect(tracking.state.leases.map((lease) => lease.state)).toEqual(["active", "active"])
    expect(calls.some((call) => call.args[0] === "stop")).toBe(false)
  })

  test("expires an idle lease but keeps a recently touched one", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([
      leaseCreate({ name: "alt", lastSeenAt: 0, ttlMs: 1_000 }),
      leaseCreate({ name: "neu", lastSeenAt: 4_999, ttlMs: 1_000 }),
    ])
    let regenerations = 0
    const result = await devLeaseReconcile({
      idleExpiryEnabled: true,
      tracking,
      runner: runnerCreate(calls, ["dev-tim-alt.service", "dev-tim-neu.service"]),
      clock: () => 5_000,
      regenerate: async () => {
        regenerations += 1
        return createResult({ revision: "r", changed: true, applied: true, attempts: 1 })
      },
    })

    expect(result).toEqual({ success: true, data: { changed: true, removed: 1, activated: 0, touched: 0 } })
    expect(tracking.state.leases.map((lease) => lease.projectKey.name)).toEqual(["neu"])
    expect(calls).toContainEqual({ command: "systemctl", args: ["stop", "dev-tim-alt.service"] })
    expect(calls).not.toContainEqual({ command: "systemctl", args: ["stop", "dev-tim-neu.service"] })
    expect(regenerations).toBe(1)
  })

  test("a lease exactly at its ttl is kept; one millisecond past is dropped", async () => {
    const at = trackingCreate([leaseCreate({ name: "rand", lastSeenAt: 4_000, ttlMs: 1_000 })])
    const atResult = await devLeaseReconcile({
      idleExpiryEnabled: true,
      tracking: at,
      runner: runnerCreate([], ["dev-tim-rand.service"]),
      clock: () => 5_000,
      regenerate: async () => createResult({ revision: "r", changed: false, applied: true, attempts: 0 }),
    })
    expect(atResult).toEqual({ success: true, data: { changed: false, removed: 0, activated: 0, touched: 0 } })
    expect(at.state.leases).toHaveLength(1)

    const past = trackingCreate([leaseCreate({ name: "rand", lastSeenAt: 3_999, ttlMs: 1_000 })])
    const pastResult = await devLeaseReconcile({
      idleExpiryEnabled: true,
      tracking: past,
      runner: runnerCreate([], ["dev-tim-rand.service"]),
      clock: () => 5_000,
      regenerate: async () => createResult({ revision: "r", changed: true, applied: true, attempts: 1 }),
    })
    expect(pastResult).toEqual({ success: true, data: { changed: true, removed: 1, activated: 0, touched: 0 } })
    expect(past.state.leases).toEqual([])
  })

  test("drops a dead unit even when the lease is fresh", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([leaseCreate({ name: "akademie", lastSeenAt: 5_000 })])
    let regenerations = 0
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate(calls, []),
      clock: () => 5_000,
      regenerate: async () => {
        regenerations += 1
        return createResult({ revision: "r", changed: true, applied: true, attempts: 1 })
      },
    })

    expect(result).toEqual({ success: true, data: { changed: true, removed: 1, activated: 0, touched: 0 } })
    expect(tracking.state.leases).toEqual([])
    expect(calls).toContainEqual({ command: "systemctl", args: ["stop", "dev-tim-akademie.service"] })
    expect(regenerations).toBe(1)
  })

  test("activates a live starting lease left behind by a crashed up", async () => {
    const tracking = trackingCreate([leaseCreate({ name: "akademie", state: "starting", lastSeenAt: 5_000 })])
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate([], ["dev-tim-akademie.service"]),
      clock: () => 6_000,
      regenerate: async () => createResult({ revision: "r", changed: true, applied: true, attempts: 1 }),
    })

    expect(result).toEqual({ success: true, data: { changed: true, removed: 0, activated: 1, touched: 0 } })
    expect(tracking.state.leases[0]).toMatchObject({ state: "active", lastSeenAt: 6_000 })
  })

  test("finishes a leftover stopping lease by stopping and dropping it", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([leaseCreate({ name: "akademie", state: "stopping", lastSeenAt: 5_000 })])
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate(calls, ["dev-tim-akademie.service"]),
      clock: () => 5_000,
      regenerate: async () => createResult({ revision: "r", changed: true, applied: true, attempts: 1 }),
    })

    expect(result).toEqual({ success: true, data: { changed: true, removed: 1, activated: 0, touched: 0 } })
    expect(tracking.state.leases).toEqual([])
    expect(calls).toContainEqual({ command: "systemctl", args: ["stop", "dev-tim-akademie.service"] })
  })

  test("a steady state with live fresh leases writes and regenerates nothing", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([leaseCreate({ name: "akademie", lastSeenAt: 5_000 })])
    let regenerations = 0
    const before = tracking.state
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate(calls, ["dev-tim-akademie.service"]),
      clock: () => 5_000,
      regenerate: async () => {
        regenerations += 1
        return createResult({ revision: "r", changed: false, applied: true, attempts: 0 })
      },
    })

    expect(result).toEqual({ success: true, data: { changed: false, removed: 0, activated: 0, touched: 0 } })
    expect(tracking.state).toBe(before)
    expect(regenerations).toBe(0)
    expect(calls.some((call) => call.args[0] === "stop")).toBe(false)
  })

  test("an unreadable unit status fails closed without changing state", async () => {
    const tracking = trackingCreate([leaseCreate({ name: "akademie", lastSeenAt: 5_000 })])
    const failing: DevProcessRunner = async () => ({
      success: false as const,
      op: "test",
      errorMessage: "transport down",
    })
    const result = await devLeaseReconcile({ tracking, runner: failing, clock: () => 5_000 })

    expect(result.success).toBe(false)
    expect(tracking.state.leases).toHaveLength(1)
  })

  test("observed HTTP activity keeps an otherwise idle lease without regenerating Caddy", async () => {
    const tracking = trackingCreate([leaseCreate({ name: "akademie", lastSeenAt: 0, ttlMs: 1_000 })])
    let regenerations = 0
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate([], ["dev-tim-akademie.service"]),
      clock: () => 5_000,
      regenerate: async () => {
        regenerations += 1
        return createResult({ revision: "r", changed: true, applied: true, attempts: 1 })
      },
      activity: { hostsCurrent: async () => [{ host: "tim-akademie.wonder1.de", seenAt: 5_000 }] },
    })

    expect(result).toEqual({ success: true, data: { changed: true, removed: 0, activated: 0, touched: 1 } })
    expect(tracking.state.leases).toHaveLength(1)
    expect(tracking.state.leases[0]?.lastSeenAt).toBe(5_000)
    expect(regenerations).toBe(0)
  })

  test("activity for an unknown hostname writes and regenerates nothing", async () => {
    const tracking = trackingCreate([leaseCreate({ name: "akademie", lastSeenAt: 5_000 })])
    let regenerations = 0
    const before = tracking.state
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate([], ["dev-tim-akademie.service"]),
      clock: () => 5_000,
      regenerate: async () => {
        regenerations += 1
        return createResult({ revision: "r", changed: false, applied: true, attempts: 0 })
      },
      activity: { hostsCurrent: async () => [{ host: "tim-werkstatt.wonder1.de", seenAt: 5_000 }] },
    })

    expect(result).toEqual({ success: true, data: { changed: false, removed: 0, activated: 0, touched: 0 } })
    expect(tracking.state).toBe(before)
    expect(regenerations).toBe(0)
  })

  test("a failing activity source degrades to TTL expiry instead of pinning the lease", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([leaseCreate({ name: "akademie", lastSeenAt: 0, ttlMs: 1_000 })])
    const result = await devLeaseReconcile({
      idleExpiryEnabled: true,
      tracking,
      runner: runnerCreate(calls, ["dev-tim-akademie.service"]),
      clock: () => 5_000,
      regenerate: async () => createResult({ revision: "r", changed: true, applied: true, attempts: 1 }),
      activity: {
        hostsCurrent: async () => {
          throw new Error("log unreadable")
        },
      },
    })

    expect(result).toEqual({ success: true, data: { changed: true, removed: 1, activated: 0, touched: 0 } })
    expect(tracking.state.leases).toEqual([])
    expect(calls).toContainEqual({ command: "systemctl", args: ["stop", "dev-tim-akademie.service"] })
  })

  test("traffic does not count as a touch for a starting lease", async () => {
    const tracking = trackingCreate([leaseCreate({ name: "akademie", state: "starting", lastSeenAt: 5_000 })])
    const result = await devLeaseReconcile({
      tracking,
      runner: runnerCreate([], ["dev-tim-akademie.service"]),
      clock: () => 6_000,
      regenerate: async () => createResult({ revision: "r", changed: true, applied: true, attempts: 1 }),
      activity: { hostsCurrent: async () => [{ host: "tim-akademie.wonder1.de", seenAt: 6_000 }] },
    })

    expect(result).toEqual({ success: true, data: { changed: true, removed: 0, activated: 1, touched: 0 } })
    expect(tracking.state.leases[0]).toMatchObject({ state: "active", lastSeenAt: 6_000 })
  })
})
