import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"

/**
 * Unit liveness for reconcile: only an `active` unit counts as alive. Any
 * other state (inactive, unknown, activating, failed) and any runner failure
 * or non-zero exit means the lease no longer has a running process.
 */
export function devUnitAlive(options: { runner: DevProcessRunner; unit: string }): PromiseResult<boolean> {
  const op = "devUnitAlive"
  if (typeof options !== "object" || options === null || typeof options.runner !== "function") {
    return Promise.resolve(createResultErrorCode(op, "dev unit status options are invalid", "caddy.unavailable"))
  }
  if (typeof options.unit !== "string" || options.unit.length === 0) {
    return Promise.resolve(createResultErrorCode(op, "dev unit status options are invalid", "caddy.unavailable"))
  }
  return aliveInternal(options.runner, options.unit, op)
}

async function aliveInternal(runner: DevProcessRunner, unit: string, op: string): PromiseResult<boolean> {
  let result: Awaited<ReturnType<DevProcessRunner>>
  try {
    result = await runner("systemctl", ["is-active", unit], "")
  } catch {
    return createResultErrorCode(op, `dev unit ${unit} status is unavailable`, "caddy.unavailable")
  }
  if (!result.success) return result
  if (result.data.exitCode !== 0) return createResult(false)
  return createResult(result.data.stdout.trim() === "active")
}
