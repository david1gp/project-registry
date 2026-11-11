import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"

/** Best-effort stop: callers in cleanup paths proceed regardless of the outcome. */
export function devUnitStop(options: { runner: DevProcessRunner; unit: string }): PromiseResult<{ unit: string }> {
  const op = "devUnitStop"
  if (typeof options !== "object" || options === null || typeof options.runner !== "function") {
    return Promise.resolve(createResultErrorCode(op, "dev unit stop options are invalid", "caddy.unavailable"))
  }
  if (typeof options.unit !== "string" || options.unit.length === 0) {
    return Promise.resolve(createResultErrorCode(op, "dev unit stop options are invalid", "caddy.unavailable"))
  }
  return stopInternal(options.runner, options.unit, op)
}

async function stopInternal(runner: DevProcessRunner, unit: string, op: string): PromiseResult<{ unit: string }> {
  let result: Awaited<ReturnType<DevProcessRunner>>
  try {
    result = await runner("systemctl", ["stop", unit], "")
  } catch {
    return createResultErrorCode(op, `dev unit ${unit} could not be stopped`, "caddy.unavailable")
  }
  if (!result.success) return result
  if (result.data.exitCode !== 0) {
    return createResultErrorCode(op, `dev unit ${unit} could not be stopped`, "caddy.unavailable")
  }
  return createResult({ unit })
}
