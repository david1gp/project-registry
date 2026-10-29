import { isIP } from "node:net"
import { createResult, createResultError, type Result } from "#result"
import { tailscaleHostnameNormalize } from "./tailscaleHostnameNormalize.js"
import type { TailscaleSplitDnsMap } from "./tailscaleSplitDnsMapSchema.js"

export type TailscaleSplitDnsRemovePlan = {
  toRemove: Record<string, null>
  alreadyAbsent: string[]
}

/**
 * Pure removal plan: owned hostnames currently resolving to exactly
 * [nodeAddress] become {host: null}; absent entries are idempotent skips.
 * A live value owned by anyone else (drifted or foreign) refuses, so removal
 * can never clear an entry this reconciler does not own.
 */
export function tailscaleSplitDnsRemovePlanCreate(
  current: TailscaleSplitDnsMap,
  hostnames: readonly string[],
  nodeAddress: string,
): Result<TailscaleSplitDnsRemovePlan> {
  const op = "tailscaleSplitDnsRemovePlanCreate"
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    return createResultError(op, "Split-DNS current map is invalid")
  }
  if (!Array.isArray(hostnames) || hostnames.length === 0) {
    return createResultError(op, "Split-DNS removal requires at least one hostname")
  }
  if (typeof nodeAddress !== "string" || isIP(nodeAddress) !== 4) {
    return createResultError(op, "Split-DNS node address must be an IPv4 address")
  }
  const toRemove: Record<string, null> = {}
  const alreadyAbsent: string[] = []
  for (const hostname of hostnames) {
    const normalized = tailscaleHostnameNormalize(hostname)
    if (normalized === undefined) {
      return createResultError(op, `Split-DNS hostname ${JSON.stringify(hostname)} is not an exact FQDN`)
    }
    const live = current[normalized]
    if (live === undefined) {
      if (!alreadyAbsent.includes(normalized)) alreadyAbsent.push(normalized)
      continue
    }
    if (!Array.isArray(live) || live.length !== 1 || live[0] !== nodeAddress) {
      return createResultError(op, `Split-DNS entry ${normalized} drifted or is foreign-owned; refusing removal`)
    }
    toRemove[normalized] = null
  }
  alreadyAbsent.sort()
  return createResult({ toRemove, alreadyAbsent })
}
