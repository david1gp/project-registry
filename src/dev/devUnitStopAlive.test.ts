import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import { devUnitAlive } from "./devUnitAlive.js"
import { devUnitStop } from "./devUnitStop.js"

type RunnerCall = { command: string; args: readonly string[] }

function runnerCreate(
  calls: RunnerCall[],
  behavior: (call: RunnerCall) => { exitCode: number; stdout: string } = () => ({ exitCode: 0, stdout: "" }),
): DevProcessRunner {
  return async (command, args, input) => {
    calls.push({ command, args })
    void input
    return createResult({ ...behavior({ command, args }), stderr: "" })
  }
}

describe("devUnitStop", () => {
  test("stops the exact unit through systemctl", async () => {
    const calls: RunnerCall[] = []
    const result = await devUnitStop({ runner: runnerCreate(calls), unit: "dev-tim-akademie.service" })

    expect(result).toEqual({ success: true, data: { unit: "dev-tim-akademie.service" } })
    expect(calls).toEqual([{ command: "systemctl", args: ["stop", "dev-tim-akademie.service"] }])
  })

  test("reports a failed stop so callers can decide to proceed", async () => {
    const result = await devUnitStop({
      runner: runnerCreate([], () => ({ exitCode: 5, stdout: "" })),
      unit: "dev-tim-akademie.service",
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("caddy.unavailable")
  })
})

describe("devUnitAlive", () => {
  test("reports active units as alive", async () => {
    const calls: RunnerCall[] = []
    const result = await devUnitAlive({
      runner: runnerCreate(calls, () => ({ exitCode: 0, stdout: "active\n" })),
      unit: "dev-tim-akademie.service",
    })

    expect(result).toEqual({ success: true, data: true })
    expect(calls).toEqual([{ command: "systemctl", args: ["is-active", "dev-tim-akademie.service"] }])
  })

  test("reports inactive, unknown, and failed units as dead", async () => {
    for (const stdout of ["inactive\n", "unknown\n", "failed\n", "activating\n"]) {
      const result = await devUnitAlive({
        runner: runnerCreate([], () => ({ exitCode: 0, stdout })),
        unit: "dev-tim-akademie.service",
      })
      expect(result).toEqual({ success: true, data: false })
    }
  })

  test("treats a non-zero is-active exit as dead instead of an error", async () => {
    const result = await devUnitAlive({
      runner: runnerCreate([], () => ({ exitCode: 3, stdout: "inactive\n" })),
      unit: "dev-tim-akademie.service",
    })

    expect(result).toEqual({ success: true, data: false })
  })

  test("a runner failure is an error, not evidence the unit is dead", async () => {
    const failing: DevProcessRunner = async () => ({
      success: false as const,
      op: "test",
      errorMessage: "transport down",
    })
    const result = await devUnitAlive({ runner: failing, unit: "dev-tim-akademie.service" })

    expect(result.success).toBe(false)
  })
})
