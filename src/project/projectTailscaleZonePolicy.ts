import { createResult, createResultErrorCode, type Result } from "#result"
import { projectDomainNormalize } from "./projectDomainNormalize.js"

/**
 * Static owner-to-zones map for self-serve private (Tailscale) DNS. One
 * writer per zone, no crossing: an owner may only claim exact hosts inside
 * their own zones. Future zones are not self-serve (code change first).
 */
export const projectTailscaleZonePolicy: Readonly<Record<string, readonly string[]>> = {
  leo: ["wonder1.de"],
  david: ["david-siewert.com"],
  fabian: ["webflows.de"],
  musa: ["covux-design.de"],
}

/**
 * Validate a private-DNS zone claim. Accepts exact hosts inside the owner's
 * zones (multi-level names included) and returns the owning zone. Rejects
 * cross-zone claims, apex/bare-zone names, and wildcard inputs with a
 * message naming the owner's allowed zones.
 */
export function projectTailscaleZoneClaimValidate(
  owner: unknown,
  hostname: unknown,
  op = "projectTailscaleZoneClaimValidate",
): Result<string> {
  const ownerName = typeof owner === "string" ? owner.trim() : ""
  if (ownerName === "") return createResultErrorCode(op, "project owner is required", "request.invalid")
  if (typeof hostname !== "string" || hostname.trim() === "") {
    return createResultErrorCode(op, `owner "${ownerName}" cannot claim an empty private domain`, "request.invalid")
  }

  const normalized = projectDomainNormalize(hostname)
  if (normalized === "") {
    return createResultErrorCode(op, `owner "${ownerName}" cannot claim an empty private domain`, "request.invalid")
  }

  const zones = projectTailscaleZonePolicy[ownerName] ?? []
  if (zones.length === 0) {
    return createResultErrorCode(
      op,
      `owner "${ownerName}" has no Tailscale zones: private domain "${normalized}" cannot be claimed`,
      "request.invalid",
    )
  }

  const allowed = zones.join(", ")
  if (normalized.includes("*")) {
    return createResultErrorCode(
      op,
      `private domain "${normalized}" is a wildcard: wildcards are forbidden; claim an exact host inside ${allowed}`,
      "request.invalid",
    )
  }
  if (zones.includes(normalized)) {
    return createResultErrorCode(
      op,
      `private domain "${normalized}" is the apex of Tailscale zone "${normalized}": apex names are never user-claimable; claim an exact host inside ${allowed}`,
      "request.invalid",
    )
  }

  const owning = zones.find((zone) => normalized.endsWith(`.${zone}`))
  if (owning !== undefined) return createResult(owning)
  return createResultErrorCode(
    op,
    `owner "${ownerName}" cannot claim private domain "${normalized}": allowed Tailscale zones: ${allowed}`,
    "request.invalid",
  )
}
