import { isIP } from "node:net"
import { createResult, createResultError, type Result } from "#result"
import type { CaddyInstanceTarget, CaddyInstanceTargets } from "./caddyInstanceTargetsResolve.js"

function bindHostPort(listener: string): { host: string; port: number } | undefined {
  const separator = listener.lastIndexOf(":")
  if (separator <= 0) return undefined
  const rawHost = listener.slice(0, separator)
  const port = Number(listener.slice(separator + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost
  if (host === "") return undefined
  return { host: host.toLowerCase(), port }
}

function bindIsExplicit(listener: string): boolean {
  const parsed = bindHostPort(listener)
  if (parsed === undefined) return false
  if (parsed.host === "*") return false
  if (isIP(parsed.host) === 0) return false
  if (parsed.host === "0.0.0.0" || parsed.host === "::") return false
  return true
}

function adminPort(adminUrl: URL): number {
  if (adminUrl.port !== "") return Number(adminUrl.port)
  return adminUrl.protocol === "https:" ? 443 : 80
}

function targetIdentityValidate(target: CaddyInstanceTarget, name: string): Result<void> {
  const op = "caddyInstanceTargetsValidate"
  if ((target.caddyUser === undefined) !== (target.caddyGroup === undefined)) {
    return createResultError(op, `${name} Caddy service User and Group must be configured together`)
  }
  return createResult(undefined)
}

// Pure semantic validation for resolved dual/single targets. Single-target
// output (no private entry) only rechecks service-identity pairing because
// flat validation already covers the rest. Dual-target output requires
// explicit address binds on both sides, distinct loopback admin endpoints on
// distinct ports, no overlapping binds, and distinct access-log roots.
export function caddyInstanceTargetsValidate(targets: CaddyInstanceTargets): Result<void> {
  const op = "caddyInstanceTargetsValidate"
  try {
    const publicIdentityR = targetIdentityValidate(targets.public, "public")
    if (!publicIdentityR.success) return publicIdentityR
    if (targets.private === undefined) return createResult(undefined)

    const privateIdentityR = targetIdentityValidate(targets.private, "private")
    if (!privateIdentityR.success) return privateIdentityR

    let publicAdmin: URL
    let privateAdmin: URL
    try {
      publicAdmin = new URL(targets.public.adminUrl)
      privateAdmin = new URL(targets.private.adminUrl)
    } catch {
      return createResultError(op, "public and private Caddy admin URLs must be valid URLs")
    }
    if (publicAdmin.href === privateAdmin.href) {
      return createResultError(op, "public and private Caddy admin URLs must differ")
    }
    if (adminPort(publicAdmin) === adminPort(privateAdmin)) {
      return createResultError(op, "public and private Caddy admin endpoints must use distinct ports")
    }

    if (targets.public.httpsListeners.length === 0 || targets.private.httpsListeners.length === 0) {
      return createResultError(op, "public and private HTTPS listeners must not be empty")
    }
    const seen = new Map<string, string>()
    for (const [name, target] of [
      ["public", targets.public],
      ["private", targets.private],
    ] as const) {
      for (const listener of target.httpsListeners) {
        if (!bindIsExplicit(listener)) {
          return createResultError(op, `${name} HTTPS listener must use an explicit address bind (${listener})`)
        }
        const parsed = bindHostPort(listener)
        if (parsed === undefined) return createResultError(op, `${name} HTTPS listener is invalid (${listener})`)
        const key = `${parsed.host}:${parsed.port}`
        const owner = seen.get(key)
        if (owner !== undefined) {
          return createResultError(op, `public and private HTTPS listeners must not overlap (${listener})`)
        }
        seen.set(key, name)
      }
    }

    if (targets.public.accessLogRoot !== undefined && targets.public.accessLogRoot === targets.private.accessLogRoot) {
      return createResultError(op, "public and private access-log roots must differ")
    }

    return createResult(undefined)
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : "invalid Caddy instance targets")
  }
}
