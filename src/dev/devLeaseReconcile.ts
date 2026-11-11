import { createResult, createResultError, type PromiseResult } from "#result"
import type { CaddyApplicationResult } from "../caddy/CaddyApplicationResult.js"
import type { DevLeaseActivitySource } from "./DevLeaseActivitySource.js"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import { devLeaseActivityTouch } from "./devLeaseActivityTouch.js"
import { devUnitAlive } from "./devUnitAlive.js"
import { devUnitStop } from "./devUnitStop.js"

export type DevLeaseReconcileResult = {
  changed: boolean
  removed: number
  activated: number
  touched: number
}

/**
 * Single reaper + startup-reconcile tick. Observed HTTP activity (an
 * optional injected source over the shared dev-lease access log) touches
 * active leases first; then, for every tracked lease in order: a `stopping`
 * leftover or a dead unit is stopped (best-effort) and dropped; an alive
 * lease idle longer than its ttlMs is stopped and dropped; an alive
 * non-active lease is marked active. Active, alive, fresh leases are kept
 * untouched.
 *
 * Persists whenever anything changed (expiry, activation, or touch) but
 * triggers Caddy regenerate only when the route set changed (expiry or
 * activation): a touch changes no route. The steady state without activity
 * stays write-free (this also keeps concurrent `up` read-modify-write
 * interleaves narrow). Without an activity source the tick behaves exactly
 * as before: only an idempotent `up` refreshes lastSeenAt.
 *
 * A failing activity source yields zero observations for that tick, so a
 * broken reader degrades to TTL expiry instead of pinning leases alive.
 */
export function devLeaseReconcile(options: {
  tracking: DevLeaseTracking
  runner: DevProcessRunner
  clock?: () => number
  regenerate?: () => PromiseResult<CaddyApplicationResult>
  activity?: DevLeaseActivitySource
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
    activity?: DevLeaseActivitySource
  },
  op: string,
): PromiseResult<DevLeaseReconcileResult> {
  if (options.tracking === undefined || options.runner === undefined) {
    return createResultError(op, "dev reconcile dependencies are unavailable")
  }
  if (options.activity !== undefined && typeof options.activity.hostsCurrent !== "function") {
    return createResultError(op, "dev reconcile activity source is invalid")
  }
  const clock = options.clock ?? Date.now
  const stateR = await options.tracking.read()
  if (!stateR.success) return stateR
  const now = clock()
  let leases = stateR.data.leases
  let touched = 0
  if (options.activity !== undefined) {
    let observations: readonly { host: string; seenAt: number }[] = []
    try {
      observations = await options.activity.hostsCurrent()
    } catch {
      observations = []
    }
    if (!Array.isArray(observations)) observations = []
    const touchR = devLeaseActivityTouch({ leases, observations, now })
    leases = touchR.leases
    touched = touchR.touched
  }
  const kept: typeof leases = []
  let removed = 0
  let activated = 0
  for (const lease of leases) {
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
  const routesChanged = removed > 0 || activated > 0
  const changed = routesChanged || touched > 0
  if (!changed) return createResult({ changed: false, removed: 0, activated: 0, touched: 0 })
  const writeR = await options.tracking.write({ version: 1, leases: kept })
  if (!writeR.success) return writeR
  if (routesChanged && options.regenerate !== undefined) {
    const regenerateR = await options.regenerate()
    if (!regenerateR.success) return regenerateR
  }
  return createResult({ changed: true, removed, activated, touched })
}
