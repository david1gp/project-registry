import { createResult, type Result } from "#result"
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
 * Validate every private route carried by a project create/edit input:
 * each requested domain must be claimable inside the owner's Tailscale
 * zones, and each route's upstream must be loopback or local-only.
 * Public, disabled, and malformed routes are left to schema validation.
 */
export function projectTailscalePrivateRoutesValidate(
  input: unknown,
  owner: string,
  op = "projectTailscalePrivateRoutesValidate",
): Result<void> {
  for (const route of tailscalePrivateRouteCollect(input)) {
    const caddy = route.caddy
    if (!caddy || typeof caddy !== "object" || Array.isArray(caddy)) continue
    if (caddy.disabled === true || caddy.networkVisibility !== "private") continue
    if (Array.isArray(caddy.domains)) {
      for (const domain of caddy.domains) {
        const claimR = projectTailscaleZoneClaimValidate(owner, domain, op)
        if (!claimR.success) return claimR
      }
    }
    const upstreamR = projectPrivateUpstreamValidate(caddy, route.serviceId, op)
    if (!upstreamR.success) return upstreamR
  }
  return createResult(undefined)
}
