import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import { devUnitStart } from "./devUnitStart.js"

type RunnerCall = { command: string; args: readonly string[]; input: string }

function runnerCreate(
  calls: RunnerCall[],
  behavior: (call: RunnerCall) => { exitCode: number; stdout: string; stderr: string } = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
): DevProcessRunner {
  return async (command, args, input) => {
    calls.push({ command, args, input })
    return createResult(behavior({ command, args, input }))
  }
}

const spec = {
  unit: "dev-tim-akademie.service",
  user: "tim",
  uid: 1002,
  workingDirectory: "/projects/akademie",
  port: 4400,
  hostname: "tim-akademie.wonder1.de",
  pathValue: "/usr/local/bin:/usr/bin",
  command: "bun",
  args: ["run", "dev"],
}

describe("devUnitStart", () => {
  test("spawns a transient user-sliced unit with an allowlisted environment and no shell", async () => {
    const calls: RunnerCall[] = []
    const result = await devUnitStart({ runner: runnerCreate(calls), spec })

    expect(result).toEqual({ success: true, data: { unit: "dev-tim-akademie.service" } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe("systemd-run")
    expect(calls[0]!.input).toBe("")
    // No shell metacharacters anywhere: every value travels as one argv entry.
    expect(calls[0]!.args.join("\n")).not.toContain("&&")
    expect(calls[0]!.args).toEqual([
      "--unit=dev-tim-akademie.service",
      "--property=User=tim",
      "--property=Slice=user-1002.slice",
      "--property=Description=project-registry dev tim/dev-tim-akademie.service",
      "--working-directory=/projects/akademie",
      "--setenv=PATH=/usr/local/bin:/usr/bin",
      "--setenv=HOME=/home/tim",
      "--setenv=PORT=4400",
      "--setenv=HOST=127.0.0.1",
      "--setenv=DEV_URL=https://tim-akademie.wonder1.de",
      "--collect",
      "--",
      "bun",
      "run",
      "dev",
    ])
  })

  test("the daemon environment is never inherited wholesale", async () => {
    const calls: RunnerCall[] = []
    await devUnitStart({ runner: runnerCreate(calls), spec: { ...spec, pathValue: "/x" } })

    const env = calls[0]!.args.filter((entry) => entry.startsWith("--setenv="))
    expect(env).toHaveLength(5)
    expect(env.join(" ")).not.toContain("CLOUDFLARE")
    expect(env.join(" ")).not.toContain("TOKEN")
  })

  test("maps a non-zero systemd-run exit to a retryable failure", async () => {
    const result = await devUnitStart({
      runner: runnerCreate([], () => ({ exitCode: 1, stdout: "", stderr: "Failed to start" })),
      spec,
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("caddy.unavailable")
  })

  test("maps a spawn throw to a failure instead of rejecting", async () => {
    const throwing: DevProcessRunner = async () => {
      throw new Error("boom")
    }
    const result = await devUnitStart({ runner: throwing, spec })

    expect(result.success).toBe(false)
  })
})
