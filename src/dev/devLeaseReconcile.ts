import { createResult, createResultError, type PromiseResult } from "#result"
import type { CaddyApplicationResult } from "../caddy/CaddyApplicationResult.js"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import { devUnitAlive } from "./devUnitAlive.js"
import { devUnitStop } from "./devUnitStop.js"

export type DevLeaseReconcileResult = {
  changed: boolean
  removed: number
  activated: number
}

/**
 * Single reaper + startup-reconcile tick. For every tracked lease, in order:
 * a `stopping` leftover or a dead unit is stopped (best-effort) and dropped;
 * an alive lease idle longer than its ttlMs is stopped and dropped; an alive
 * non-active lease is marked active. Active, alive, fresh leases are kept
 * untouched. Persists and triggers Caddy regenerate only when something
 * changed, so the steady state is write-free (this also keeps concurrent
 * `up` read-modify-write interleaves narrow).
 *
 * HTTP activity does NOT touch leases here (named gap DEV-HTTP-ACTIVITY:
 * lease hostnames are synthetic, never registry rows, so no per-host access
 * log exists for them; the access-log layout is per project row). Only an
 * idempotent `up` refreshes lastSeenAt.
 */
export function devLeaseReconcile(options: {
  tracking: DevLeaseTracking
  runner: DevProcessRunner
  clock?: () => number
  regenerate?: () => PromiseResult<CaddyApplicationResult>
}): PromiseResult<DevLeaseReconcileResult> {
  const op = "devLeaseReconcile"
  if (typeof options !== "object" || options === null) {
    return Promise.resolve(createResultError(op, "dev reconcile options are required"))
  }
  return reconcileInternal(options, op)
}

async function reconcileInternal(
  options: {
    tracking: DevLeaseTracking
    runner: DevProcessRunner
    clock?: () => number
    regenerate?: () => PromiseResult<CaddyApplicationResult>
  },
  op: string,
): PromiseResult<DevLeaseReconcileResult> {
  if (options.tracking === undefined || options.runner === undefined) {
    return createResultError(op, "dev reconcile dependencies are unavailable")
  }
  const clock = options.clock ?? Date.now
  const stateR = await options.tracking.read()
  if (!stateR.success) return stateR
  const now = clock()
  const kept: typeof stateR.data.leases = []
  let removed = 0
  let activated = 0
  for (const lease of stateR.data.leases) {
    if (lease.state === "stopping") {
      await devUnitStop({ runner: options.runner, unit: lease.unit })
      removed += 1
      continue
    }
    const aliveR = await devUnitAlive({ runner: options.runner, unit: lease.unit })
    if (!aliveR.success) return aliveR
    if (!aliveR.data) {
      await devUnitStop({ runner: options.runner, unit: lease.unit })
      removed += 1
      continue
    }
    if (now - lease.lastSeenAt > lease.ttlMs) {
      await devUnitStop({ runner: options.runner, unit: lease.unit })
      removed += 1
      continue
    }
    if (lease.state !== "active") {
      kept.push({ ...lease, state: "active", lastSeenAt: now })
      activated += 1
      continue
    }
    kept.push(lease)
  }
  const changed = removed > 0 || activated > 0
  if (!changed) return createResult({ changed: false, removed: 0, activated: 0 })
  const writeR = await options.tracking.write({ version: 1, leases: kept })
  if (!writeR.success) return writeR
  if (options.regenerate !== undefined) {
    const regenerateR = await options.regenerate()
    if (!regenerateR.success) return regenerateR
  }
  return createResult({ changed: true, removed, activated })
}
