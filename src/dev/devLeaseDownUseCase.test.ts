import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"
import type { DevLeaseTrackingState } from "./devLeaseTrackingState.js"
import { devLeaseDownUseCase } from "./devLeaseDownUseCase.js"

type RunnerCall = { command: string; args: readonly string[]; input: string }

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

function leaseCreate(): DevLeaseRecord {
  return {
    projectKey: { owner: "tim", name: "akademie" },
    user: "tim",
    port: 4400,
    unit: "dev-tim-akademie.service",
    hostname: "tim-akademie.wonder1.de",
    state: "active",
    ttlMs: 14_400_000,
    lastSeenAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
  }
}

describe("devLeaseDownUseCase", () => {
  test("stops the unit, deletes the lease, regenerates, and reports the stop", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([leaseCreate()])
    let regenerations = 0
    const result = await devLeaseDownUseCase({
      user: "tim",
      name: "akademie",
      tracking,
      runner: async (command, args, input) => {
        calls.push({ command, args, input })
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      regenerate: async () => {
        regenerations += 1
        return createResult({ revision: "r", changed: true, applied: true, attempts: 1 })
      },
    })

    expect(result).toEqual({
      success: true,
      data: { project: "akademie", owner: "tim", hostname: "tim-akademie.wonder1.de", stopped: true },
    })
    expect(calls).toEqual([{ command: "systemctl", args: ["stop", "dev-tim-akademie.service"], input: "" }])
    expect(tracking.state.leases).toEqual([])
    expect(regenerations).toBe(1)
  })

  test("reports a missing lease as not found without touching the runner", async () => {
    const calls: RunnerCall[] = []
    const tracking = trackingCreate([])
    const runner: DevProcessRunner = async (command, args, input) => {
      calls.push({ command, args, input })
      return createResult({ exitCode: 0, stdout: "", stderr: "" })
    }
    const result = await devLeaseDownUseCase({
      user: "tim",
      name: "akademie",
      tracking,
      runner,
      regenerate: async () => createResult({ revision: "r", changed: false, applied: true, attempts: 0 }),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("projects.not-found")
    expect(calls).toEqual([])
  })

  test("a stuck unit still loses its lease and route", async () => {
    const tracking = trackingCreate([leaseCreate()])
    let regenerations = 0
    const result = await devLeaseDownUseCase({
      user: "tim",
      name: "akademie",
      tracking,
      runner: async () => createResult({ exitCode: 1, stdout: "", stderr: " refused" }),
      regenerate: async () => {
        regenerations += 1
        return createResult({ revision: "r", changed: true, applied: true, attempts: 1 })
      },
    })

    expect(result.success).toBe(true)
    expect(tracking.state.leases).toEqual([])
    expect(regenerations).toBe(1)
  })

  test("a regenerate failure surfaces after the lease is deleted", async () => {
    const tracking = trackingCreate([leaseCreate()])
    const result = await devLeaseDownUseCase({
      user: "tim",
      name: "akademie",
      tracking,
      runner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
      regenerate: async () => ({ success: false as const, op: "test", errorMessage: "Caddy admin is down" }),
    })

    expect(result.success).toBe(false)
    // The lease is already gone; a later regenerate reconverges the routes.
    expect(tracking.state.leases).toEqual([])
  })
})
