import { isIP } from "node:net"
import { createResult, createResultError, type Result } from "#result"
import { tailscaleHostnameNormalize } from "./tailscaleHostnameNormalize.js"
import type { TailscaleSplitDnsMap } from "./tailscaleSplitDnsMapSchema.js"

export type TailscaleSplitDnsPlan = {
  nodeAddress: string
  hostnames: string[]
  desired: Record<string, string[]>
  unchanged: string[]
  toApply: Record<string, string[]>
}

/**
 * Pure plan: owned exact private FQDNs map to [nodeAddress]. Unrelated
 * split-DNS entries are never included in the patch; only the supplied owned
 * hostnames are compared, so foreign entries and global resolvers stay
 * untouched. MagicDNS is out of scope for split-DNS PATCH.
 */
export function tailscaleSplitDnsPlanCreate(
  current: TailscaleSplitDnsMap,
  desired: { hostnames: readonly string[]; nodeAddress: string },
): Result<TailscaleSplitDnsPlan> {
  const op = "tailscaleSplitDnsPlanCreate"
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    return createResultError(op, "Split-DNS current map is invalid")
  }
  if (typeof desired !== "object" || desired === null) {
    return createResultError(op, "Split-DNS desired state is invalid")
  }
  if (!Array.isArray(desired.hostnames)) {
    return createResultError(op, "Split-DNS desired hostnames are invalid")
  }
  if (typeof desired.nodeAddress !== "string" || isIP(desired.nodeAddress) !== 4) {
    return createResultError(op, "Split-DNS node address must be an IPv4 address")
  }
  const hostnames: string[] = []
  const seen = new Set<string>()
  for (const hostname of desired.hostnames) {
    const normalized = tailscaleHostnameNormalize(hostname)
    if (normalized === undefined) {
      return createResultError(op, `Split-DNS hostname ${JSON.stringify(hostname)} is not an exact FQDN`)
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    hostnames.push(normalized)
  }
  hostnames.sort()
  const desiredMap: Record<string, string[]> = {}
  for (const hostname of hostnames) desiredMap[hostname] = [desired.nodeAddress]
  const unchanged: string[] = []
  const toApply: Record<string, string[]> = {}
  for (const hostname of hostnames) {
    const existing = current[hostname]
    if (Array.isArray(existing) && existing.length === 1 && existing[0] === desired.nodeAddress) {
      unchanged.push(hostname)
      continue
    }
    toApply[hostname] = [desired.nodeAddress]
  }
  return createResult({ nodeAddress: desired.nodeAddress, hostnames, desired: desiredMap, unchanged, toApply })
}
