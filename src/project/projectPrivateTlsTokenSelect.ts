import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { projectTailscaleZoneClaimValidate } from "./projectTailscaleZonePolicy.js"

export type ProjectPrivateTlsTokenSelection = {
  owner: string
  zone: string
}

/**
 * Select which owner's Cloudflare credential funds DNS-01 for a private
 * hostname: the claiming owner, never a hardcoded fallback. The claim must
 * validate against the owner-zone policy, so cross-zone attempts fail here
 * with the allowed-zone list instead of silently using another owner's token.
 */
export function projectPrivateTlsTokenOwnerSelect(
  owner: unknown,
  hostname: unknown,
  op = "projectPrivateTlsTokenOwnerSelect",
): Result<ProjectPrivateTlsTokenSelection> {
  const ownerName = typeof owner === "string" ? owner.trim() : ""
  if (ownerName === "") {
    return createResultError(op, "private TLS token owner is required")
  }
  const zoneR = projectTailscaleZoneClaimValidate(ownerName, hostname, op)
  if (!zoneR.success) return zoneR
  return createResult({ owner: ownerName, zone: zoneR.data })
}

/**
 * Resolve the DNS-01 token for a private hostname through the caller's
 * credential resolver (the daemon passes its per-owner Cloudflare credential
 * resolver). Validates the zone claim first; resolves nothing for rejected
 * claims. The token value is returned, never logged or printed.
 */
export async function projectPrivateTlsTokenResolve(options: {
  owner: unknown
  hostname: unknown
  credentialResolve: (owner: string) => PromiseResult<string | undefined>
  op?: string
}): PromiseResult<ProjectPrivateTlsTokenSelection & { token: string | undefined }> {
  const op = options?.op ?? "projectPrivateTlsTokenResolve"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "private TLS token options are required")
  }
  if (typeof options.credentialResolve !== "function") {
    return createResultError(op, "private TLS credential resolver is required")
  }
  const selectionR = projectPrivateTlsTokenOwnerSelect(options.owner, options.hostname, op)
  if (!selectionR.success) return selectionR
  let resolved: Awaited<ReturnType<typeof options.credentialResolve>>
  try {
    resolved = await options.credentialResolve(selectionR.data.owner)
  } catch {
    return createResultError(op, "private TLS credentials could not be loaded")
  }
  if (typeof resolved !== "object" || resolved === null || typeof resolved.success !== "boolean") {
    return createResultError(op, "private TLS credentials could not be loaded")
  }
  if (!resolved.success) {
    return createResultError(op, "private TLS credentials could not be loaded")
  }
  if (
    resolved.data !== undefined &&
    (typeof resolved.data !== "string" || resolved.data.length === 0 || resolved.data.trim() !== resolved.data)
  ) {
    return createResultError(op, "private TLS credentials are invalid")
  }
  return createResult({ ...selectionR.data, token: resolved.data })
}
