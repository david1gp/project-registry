import { createResult, createResultErrorCode, type Result } from "#result"

function upstreamHostPart(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    if (end < 0) return trimmed
    return trimmed.slice(1, end)
  }
  const firstColon = trimmed.indexOf(":")
  if (firstColon < 0) return trimmed
  if (trimmed.indexOf(":", firstColon + 1) >= 0) return trimmed
  return trimmed.slice(0, firstColon)
}

function upstreamHostIsLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, "")
  if (normalized === "localhost" || normalized === "::1") return true
  const octets = normalized.split(".")
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

/**
 * Loopback-upstream guard for private routes. Applies only when
 * `networkVisibility` resolves to private; public, disabled, and
 * non-object routes pass untouched. A private route is local-only when it
 * carries no explicit upstream (Caddy dials `localhost:<port>`) or when
 * its explicit upstream is loopback (`127.0.0.1`/`::1`/`localhost`, with
 * or without a port) or a bare port. Anything else fails with the
 * tailnet-wide exposure reason and the fix.
 */
export function projectPrivateUpstreamValidate(
  route: unknown,
  label = "default",
  op = "projectPrivateUpstreamValidate",
): Result<void> {
  if (!route || typeof route !== "object" || Array.isArray(route)) return createResult(undefined)
  const record = route as Record<string, unknown>
  if (record.networkVisibility !== "private") return createResult(undefined)
  if (record.disabled === true) return createResult(undefined)

  const upstream = record.upstream
  if (upstream === undefined || upstream === null) return createResult(undefined)
  if (typeof upstream === "number") return createResult(undefined)
  if (typeof upstream !== "string") return createResult(undefined)
  const trimmed = upstream.trim()
  if (trimmed === "" || /^\d+$/.test(trimmed)) return createResult(undefined)
  if (upstreamHostIsLoopback(upstreamHostPart(trimmed))) return createResult(undefined)

  return createResultErrorCode(
    op,
    `private route "${label}" uses non-loopback upstream "${trimmed}": private names resolve tailnet-wide, so every tailnet device could reach this upstream. Fix: bind the service to loopback (127.0.0.1, ::1, or localhost) or keep the route on a local-only port.`,
    "request.invalid",
  )
}
