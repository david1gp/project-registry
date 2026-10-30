import { tailscaleHostnameNormalize } from "./tailscaleHostnameNormalize.js"

/**
 * Normalize a grandfathered-hostnames list: exact private FQDNs that keep
 * converging even though the zone policy rejects them (a bare apex or a
 * pre-policy cross-zone name). Returns undefined when any entry is missing,
 * not an array, or not an exact host — wildcards and single labels fail
 * closed so the exception can never widen to whole zones.
 */
export function tailscaleGrandfatheredHostnamesNormalize(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const hostnames: string[] = []
  for (const entry of input) {
    const normalized = tailscaleHostnameNormalize(entry)
    if (normalized === undefined) return undefined
    if (!hostnames.includes(normalized)) hostnames.push(normalized)
  }
  return hostnames
}
