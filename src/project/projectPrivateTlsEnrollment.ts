import { isIP } from "node:net"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import { projectPrivateTlsTokenResolve } from "./projectPrivateTlsTokenSelect.js"
import { projectTailscaleZoneClaimValidate } from "./projectTailscaleZonePolicy.js"

/**
 * Public resolvers used for private-Caddy DNS-01 challenges. Challenges must
 * never go through the private listener: it only serves the tailnet names,
 * while the ACME DNS-01 TXT records live in public DNS.
 */
export const projectPrivateTlsChallengeResolversDefault: readonly string[] = ["1.1.1.1", "8.8.8.8"]

export type ProjectPrivateTlsEnrollmentKind = "wildcard" | "per-host"

export type ProjectPrivateTlsEnrollmentHost = {
  hostname: string
  zone: string
  enrollment: ProjectPrivateTlsEnrollmentKind
}

export type ProjectPrivateTlsEnrollmentPlan = {
  owner: string
  hosts: ProjectPrivateTlsEnrollmentHost[]
  /** Multi-level hostnames needing their own per-host DNS-01 enrollment. */
  enroll: string[]
  /** Single-level hostnames already covered by the zone wildcard. */
  wildcardCovered: string[]
}

function ownerNormalize(owner: unknown): string {
  return typeof owner === "string" ? owner.trim() : ""
}

/**
 * Build the per-host enrollment plan for one claiming owner. Every hostname
 * is validated against the owner-zone policy first, so cross-zone, apex, and
 * wildcard inputs fail here naming the allowed zones. Single-level names
 * (one label below the zone) are wildcard-covered and need no enrollment;
 * multi-level names need per-host DNS-01 enrollment.
 */
export function projectPrivateTlsEnrollmentPlanCreate(
  owner: unknown,
  hostnames: unknown,
  op = "projectPrivateTlsEnrollmentPlanCreate",
): Result<ProjectPrivateTlsEnrollmentPlan> {
  const ownerName = ownerNormalize(owner)
  if (ownerName === "") {
    return createResultError(op, "private TLS enrollment owner is required")
  }
  if (!Array.isArray(hostnames)) {
    return createResultError(op, "private TLS enrollment hostnames are required")
  }
  const seen = new Set<string>()
  const hosts: ProjectPrivateTlsEnrollmentHost[] = []
  for (const entry of hostnames) {
    if (typeof entry !== "string") {
      return createResultError(op, "private TLS enrollment hostnames must be strings")
    }
    const hostname = projectDomainNormalize(entry)
    if (hostname === "") {
      return createResultError(op, `owner "${ownerName}" cannot enroll an empty private hostname`)
    }
    if (seen.has(hostname)) continue
    seen.add(hostname)
    const zoneR = projectTailscaleZoneClaimValidate(ownerName, hostname, op)
    if (!zoneR.success) return zoneR
    const zone = zoneR.data
    const label = hostname.slice(0, -(zone.length + 1))
    const enrollment: ProjectPrivateTlsEnrollmentKind = label.includes(".") ? "per-host" : "wildcard"
    hosts.push({ hostname, zone, enrollment })
  }
  hosts.sort((left, right) => (left.hostname < right.hostname ? -1 : left.hostname > right.hostname ? 1 : 0))
  return createResult({
    owner: ownerName,
    hosts,
    enroll: hosts.filter((host) => host.enrollment === "per-host").map((host) => host.hostname),
    wildcardCovered: hosts.filter((host) => host.enrollment === "wildcard").map((host) => host.hostname),
  })
}

/**
 * Validate the DNS-01 challenge resolvers: public IPv4 resolvers only, never
 * the private listener. `privateAddresses` carries the addresses that must
 * not appear (the daemon passes its tailnet node address); loopback is
 * always rejected.
 */
export function projectPrivateTlsChallengeResolversValidate(
  resolvers: unknown,
  options: { privateAddresses?: readonly unknown[]; op?: string } = {},
): Result<string[]> {
  const op = options?.op ?? "projectPrivateTlsChallengeResolversValidate"
  if (!Array.isArray(resolvers) || resolvers.length === 0) {
    return createResultError(op, "private TLS challenge resolvers are required")
  }
  const privateAddresses = new Set<string>()
  if (options?.privateAddresses !== undefined) {
    if (!Array.isArray(options.privateAddresses)) {
      return createResultError(op, "private TLS private addresses are invalid")
    }
    for (const entry of options.privateAddresses) {
      if (typeof entry !== "string" || entry.trim() === "") {
        return createResultError(op, "private TLS private addresses are invalid")
      }
      privateAddresses.add(entry.trim())
    }
  }
  const validated: string[] = []
  for (const entry of resolvers) {
    if (typeof entry !== "string" || isIP(entry.trim()) !== 4) {
      return createResultError(op, "private TLS challenge resolvers must be IPv4 addresses")
    }
    const resolver = entry.trim()
    if (resolver.startsWith("127.")) {
      return createResultError(op, `private TLS challenge resolver ${resolver} is not a public resolver`)
    }
    if (privateAddresses.has(resolver)) {
      return createResultError(
        op,
        `private TLS challenge resolver ${resolver} is the private listener; challenges use public resolvers only`,
      )
    }
    if (!validated.includes(resolver)) validated.push(resolver)
  }
  return createResult(validated)
}

/**
 * Prepare per-host DNS-01 enrollment for one claiming owner: the enrollment
 * plan plus the claiming owner's Cloudflare token (never a global token)
 * and the validated public challenge resolvers. When every hostname is
 * wildcard-covered there is nothing to enroll and the credential resolver
 * is not called at all. The token value is returned, never logged.
 */
export async function projectPrivateTlsEnrollmentPrepare(options: {
  owner: unknown
  hostnames: unknown
  resolvers?: unknown
  privateAddresses?: readonly unknown[]
  credentialResolve: (owner: string) => PromiseResult<string | undefined>
  op?: string
}): PromiseResult<{
  plan: ProjectPrivateTlsEnrollmentPlan
  resolvers: string[]
  token: string | undefined
}> {
  const op = options?.op ?? "projectPrivateTlsEnrollmentPrepare"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "private TLS enrollment options are required")
  }
  if (typeof options.credentialResolve !== "function") {
    return createResultError(op, "private TLS credential resolver is required")
  }
  const planR = projectPrivateTlsEnrollmentPlanCreate(options.owner, options.hostnames, op)
  if (!planR.success) return planR
  const resolversR = projectPrivateTlsChallengeResolversValidate(
    options.resolvers ?? [...projectPrivateTlsChallengeResolversDefault],
    { ...(options.privateAddresses === undefined ? {} : { privateAddresses: options.privateAddresses }), op },
  )
  if (!resolversR.success) return resolversR
  if (planR.data.enroll.length === 0) {
    return createResult({ plan: planR.data, resolvers: resolversR.data, token: undefined })
  }
  const tokenR = await projectPrivateTlsTokenResolve({
    owner: planR.data.owner,
    hostname: planR.data.enroll[0],
    credentialResolve: options.credentialResolve,
    op,
  })
  if (!tokenR.success) return tokenR
  return createResult({ plan: planR.data, resolvers: resolversR.data, token: tokenR.data.token })
}
