/**
 * Normalize an exact private FQDN: lowercase, strip one trailing dot, reject
 * wildcards, single-label names, and malformed labels. Zone ownership is
 * decided by the caller (the daemon validates claims against
 * `projectTailscaleZonePolicy`); this only guarantees the exact-host shape so
 * split-DNS and dnsmasq inputs can never widen to whole zones.
 */
export function tailscaleHostnameNormalize(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return undefined
  const withoutTrailingDot = value.endsWith(".") ? value.slice(0, -1) : value
  if (withoutTrailingDot.length === 0 || withoutTrailingDot.length > 253 || withoutTrailingDot.includes("..")) {
    return undefined
  }
  if (withoutTrailingDot.includes("*")) return undefined
  const labels = withoutTrailingDot.split(".")
  if (labels.length < 2) return undefined
  if (
    labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) {
    return undefined
  }
  return withoutTrailingDot.toLowerCase()
}
