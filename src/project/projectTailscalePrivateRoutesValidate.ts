import { createResult, type Result } from "#result"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import { projectPrivateUpstreamValidate } from "./projectPrivateUpstreamValidate.js"
import { projectTailscaleZoneClaimValidate } from "./projectTailscaleZonePolicy.js"

type TailscalePrivateRoute = {
  serviceId: string
  caddy: Record<string, unknown>
}

function tailscalePrivateRouteCollect(input: unknown): TailscalePrivateRoute[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  const routes: TailscalePrivateRoute[] = []
  if (record.caddy !== undefined && record.caddy !== null) {
    routes.push({ serviceId: "default", caddy: record.caddy as Record<string, unknown> })
  }
  if (Array.isArray(record.services)) {
    for (const service of record.services) {
      if (!service || typeof service !== "object" || Array.isArray(service)) continue
      const serviceRecord = service as Record<string, unknown>
      if (serviceRecord.caddy === undefined || serviceRecord.caddy === null) continue
      routes.push({
        serviceId: typeof serviceRecord.id === "string" ? serviceRecord.id : "default",
        caddy: serviceRecord.caddy as Record<string, unknown>,
      })
    }
  }
  return routes
}

/**
 * Domains this project already serves privately. A rename migration moves
 * rows zone by zone, so pre-migration claims keep working until they are
 * renamed; only newly added (or newly privatized) domains must fall inside
 * the owner's current zones.
 */
export function projectTailscalePrivateRouteDomains(input: unknown): string[] {
  const domains = new Set<string>()
  for (const route of tailscalePrivateRouteCollect(input)) {
    const caddy = route.caddy
    if (!caddy || typeof caddy !== "object" || Array.isArray(caddy)) continue
    if (caddy.disabled === true || caddy.networkVisibility !== "private") continue
    if (!Array.isArray(caddy.domains)) continue
    for (const domain of caddy.domains) {
      if (typeof domain !== "string") continue
      const normalized = projectDomainNormalize(domain)
      if (normalized !== "") domains.add(normalized)
    }
  }
  return [...domains].sort()
}

/**
 * Validate every private route carried by a project create/edit input:
 * each requested domain must be claimable inside the owner's Tailscale
 * zones, and each route's upstream must be loopback or local-only.
 * Public, disabled, and malformed routes are left to schema validation.
 * Domains in `grandfatheredDomains` (normalized hostnames this project
 * already serves privately) skip the claim check but not the upstream
 * guard; creates pass nothing and validate every domain.
 */
export function projectTailscalePrivateRoutesValidate(
  input: unknown,
  owner: string,
  op = "projectTailscalePrivateRoutesValidate",
  grandfatheredDomains: readonly unknown[] = [],
): Result<void> {
  const grandfathered = new Set(
    grandfatheredDomains.flatMap((domain) => {
      if (typeof domain !== "string") return []
      const normalized = projectDomainNormalize(domain)
      return normalized === "" ? [] : [normalized]
    }),
  )
  for (const route of tailscalePrivateRouteCollect(input)) {
    const caddy = route.caddy
    if (!caddy || typeof caddy !== "object" || Array.isArray(caddy)) continue
    if (caddy.disabled === true || caddy.networkVisibility !== "private") continue
    if (Array.isArray(caddy.domains)) {
      for (const domain of caddy.domains) {
        if (typeof domain === "string" && grandfathered.has(projectDomainNormalize(domain))) continue
        const claimR = projectTailscaleZoneClaimValidate(owner, domain, op)
        if (!claimR.success) return claimR
      }
    }
    const upstreamR = projectPrivateUpstreamValidate(caddy, route.serviceId, op)
    if (!upstreamR.success) return upstreamR
  }
  return createResult(undefined)
}
