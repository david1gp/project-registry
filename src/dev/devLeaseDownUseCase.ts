import { createResult, createResultError, createResultErrorCode, type PromiseResult } from "#result"
import type { CaddyApplicationResult } from "../caddy/CaddyApplicationResult.js"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import { devUnitStop } from "./devUnitStop.js"

export type DevLeaseDownResult = {
  project: string
  owner: string
  hostname: string
  stopped: true
}

export function devLeaseDownUseCase(options: {
  user: string
  name: string
  serviceId?: string
  tracking: DevLeaseTracking
  runner: DevProcessRunner
  regenerate: () => PromiseResult<CaddyApplicationResult>
}): PromiseResult<DevLeaseDownResult> {
  const op = "devLeaseDown"
  if (typeof options !== "object" || options === null) {
    return Promise.resolve(createResultError(op, "dev down options are required"))
  }
  return downInternal(options, op)
}

async function downInternal(
  options: {
    user: string
    name: string
    serviceId?: string
    tracking: DevLeaseTracking
    runner: DevProcessRunner
    regenerate: () => PromiseResult<CaddyApplicationResult>
  },
  op: string,
): PromiseResult<DevLeaseDownResult> {
  if (options.tracking === undefined || options.runner === undefined || options.regenerate === undefined) {
    return createResultError(op, "dev down dependencies are unavailable")
  }
  if (typeof options.user !== "string" || typeof options.name !== "string") {
    return createResultError(op, "dev down options are invalid")
  }
  const stateR = await options.tracking.read()
  if (!stateR.success) return stateR
  const existing = stateR.data.leases.find(
    (lease) =>
      lease.projectKey.owner === options.user &&
      lease.projectKey.name === options.name &&
      (lease.serviceId ?? undefined) === (options.serviceId ?? undefined),
  )
  if (existing === undefined) {
    return createResultErrorCode(op, `dev server ${options.user}/${options.name} is not running`, "projects.not-found")
  }
  // Best-effort stop: the route removal below is the user-visible,
  // security-relevant part, and `dev down` in automation finally-blocks must
  // not leave it behind because a unit is stuck. A surviving process keeps its
  // loopback port bound, so the next `up` fails loudly at health wait instead
  // of silently shadowing it.
  await devUnitStop({ runner: options.runner, unit: existing.unit })
  const writeR = await options.tracking.write({
    version: 1,
    leases: stateR.data.leases.filter((lease) => lease !== existing),
  })
  if (!writeR.success) return writeR
  const regenerateR = await options.regenerate()
  if (!regenerateR.success) return regenerateR
  return createResult({ project: options.name, owner: options.user, hostname: existing.hostname, stopped: true })
}
