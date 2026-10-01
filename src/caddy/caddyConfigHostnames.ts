import { isIP } from "node:net"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import { projectDomainValidate } from "../project/projectDomainValidate.js"
import type { CaddyConfig } from "./CaddyConfig.js"

function objectIs(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Positive host matchers in active HTTP routes, including opaque imported subroutes. */
export function caddyConfigHostnames(config: CaddyConfig): string[] {
  const hosts = new Set<string>()
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (!objectIs(value)) return
    if (Array.isArray(value.match)) {
      for (const matcher of value.match) {
        if (!objectIs(matcher) || !Array.isArray(matcher.host)) continue
        for (const host of matcher.host) {
          if (typeof host !== "string") continue
          const domain = projectDomainNormalize(host)
          if (domain.includes(".") && isIP(domain) === 0 && projectDomainValidate(domain).success) hosts.add(domain)
        }
      }
    }
    visit(value.routes)
    visit(value.handle)
  }
  for (const server of Object.values(config.apps.http.servers)) visit(server.routes)
  return [...hosts].sort()
}
