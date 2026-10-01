import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { caddyConfigBaseMergeOptionsSchema } from "./caddyConfigBaseMergeOptionsSchema.js"
import { type CaddyJsonObject, caddyJsonObjectSchema } from "./caddyJsonObjectSchema.js"

type JsonValue = CaddyJsonObject[string]
type HostScope = { hosts: string[]; exclusive: boolean }
type RouteEntry = { route: CaddyJsonObject; scope: HostScope; serverName: string; index: number }
const op = "caddyConfigBaseMerge"

function objectIs(value: JsonValue | undefined): value is CaddyJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hostNormalize(host: string): string {
  return host.toLowerCase().replace(/\.$/, "")
}

function routeScope(route: CaddyJsonObject): HostScope {
  if (!Array.isArray(route.match) || route.match.length === 0) return { hosts: [], exclusive: false }
  const hosts: string[] = []
  let exclusive = route.match.length === 1
  for (const matcher of route.match) {
    if (!objectIs(matcher) || !Array.isArray(matcher.host) || matcher.host.length === 0) {
      return { hosts: [], exclusive: false }
    }
    if (Object.keys(matcher).length !== 1) exclusive = false
    for (const host of matcher.host) {
      if (typeof host !== "string" || host.length === 0) return { hosts: [], exclusive: false }
      hosts.push(hostNormalize(host))
    }
  }
  return { hosts, exclusive }
}

function hostPatternOverlaps(pattern: string, host: string): boolean {
  if (pattern === host) return true
  // Deliberately conservative: '*' may cover more than Caddy's wildcard matcher.
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`^${escaped.join(".*")}$`, "i").test(host)
}

function httpServers(config: CaddyJsonObject): Result<CaddyJsonObject> {
  if (!objectIs(config.apps) || !objectIs(config.apps.http) || !objectIs(config.apps.http.servers)) {
    return createResultError(op, "Expected apps.http.servers in the Caddy JSON configuration.")
  }
  return createResult(config.apps.http.servers)
}

function routesRead(servers: CaddyJsonObject): Result<RouteEntry[]> {
  const entries: RouteEntry[] = []
  for (const [serverName, server] of Object.entries(servers)) {
    if (!objectIs(server) || (server.routes !== undefined && !Array.isArray(server.routes))) {
      return createResultError(op, `Invalid HTTP server/routes: ${serverName}.`)
    }
    for (const [index, route] of (Array.isArray(server.routes) ? server.routes : []).entries()) {
      if (!objectIs(route)) return createResultError(op, `Invalid route: ${serverName}/${index}.`)
      entries.push({ route, scope: routeScope(route), serverName, index })
    }
  }
  return createResult(entries)
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonEqual(entry, right[index]!))
  }
  if (!objectIs(left) || !objectIs(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key]!, right[key]!))
  )
}

/** Add missing dependencies only; never overwrite an imported policy or array. */
function dependenciesMerge(base: CaddyJsonObject, generated: CaddyJsonObject, path: string): Result<CaddyJsonObject> {
  const entries = new Map(Object.entries(base))
  for (const [key, value] of Object.entries(generated)) {
    const existing = entries.get(key)
    if (existing === undefined) {
      entries.set(key, value)
      continue
    }
    if (jsonEqual(existing, value)) continue
    if (objectIs(existing) && objectIs(value)) {
      const merged = dependenciesMerge(existing, value, `${path}/${key}`)
      if (!merged.success) return merged
      entries.set(key, merged.data)
      continue
    }
    return createResultError(
      op,
      `Conflicting generated configuration at ${path}/${key}; base policies are never overwritten.`,
    )
  }
  return createResult(Object.fromEntries(entries))
}

/**
 * Pure optional-base merge. Without baseConfig, returns generated JSON unchanged.
 * managedHosts grants deletion/replacement authority, not ownership inferred from imports.
 * See docs/20261001_caddy_base_merge.md for the conservative conflict/deletion contract.
 */
export function caddyConfigBaseMerge(generatedConfig: unknown, options: unknown = {}): Result<CaddyJsonObject> {
  const generatedR = a.safeParse(caddyJsonObjectSchema, generatedConfig)
  if (!generatedR.success) return createResultError(op, "Generated configuration must be a JSON object.")
  const optionsR = a.safeParse(caddyConfigBaseMergeOptionsSchema, options)
  if (!optionsR.success) return createResultError(op, `Invalid merge options: ${a.summarize(optionsR.issues)}`)
  const generated = generatedR.output
  const base = optionsR.output.baseConfig
  if (base === undefined) return createResult(generated)

  const generatedServersR = httpServers(generated)
  if (!generatedServersR.success) return generatedServersR
  const baseServersR = httpServers(base)
  if (!baseServersR.success) return baseServersR
  const generatedServerNames = Object.keys(generatedServersR.data)
  if (generatedServerNames.length !== 1)
    return createResultError(op, "Generated configuration must contain exactly one HTTP server.")
  const generatedServerName = generatedServerNames[0]!
  const targetServerName = optionsR.output.targetServerName ?? generatedServerName
  const target = baseServersR.data[targetServerName]
  const generatedServer = generatedServersR.data[generatedServerName]
  if (!objectIs(target) || !objectIs(generatedServer)) {
    return createResultError(op, `The explicit target HTTP server must exist in the base: ${targetServerName}.`)
  }
  const baseRoutesR = routesRead(baseServersR.data)
  if (!baseRoutesR.success) return baseRoutesR
  const generatedRoutesR = routesRead(generatedServersR.data)
  if (!generatedRoutesR.success) return generatedRoutesR
  const generatedRoutes = generatedRoutesR.data
  const owned = new Set((optionsR.output.managedHosts ?? []).map(hostNormalize))
  const generatedHosts = new Set<string>()
  const generatedByHost = new Map<string, RouteEntry>()
  for (const entry of generatedRoutes) {
    if (!entry.scope.exclusive || entry.scope.hosts.length === 0 || entry.route.group !== undefined) {
      return createResultError(op, "Generated routes must have one host-only matcher and no shared group.")
    }
    for (const host of entry.scope.hosts) {
      if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(host)) {
        return createResultError(op, "Generated hosts must be exact domain names, not wildcard/dynamic matchers.")
      }
      if (generatedHosts.has(host)) return createResultError(op, `Duplicate generated host: ${host}.`)
      generatedHosts.add(host)
      generatedByHost.set(host, entry)
    }
  }

  const affectedHosts = new Set([...owned, ...generatedHosts])
  const replacements = new Map<number, RouteEntry | undefined>()
  const usedGenerated = new Set<RouteEntry>()
  const matchedHosts = new Set<string>()
  for (const entry of baseRoutesR.data) {
    if (affectedHosts.size === 0) break
    if (entry.scope.hosts.length === 0) {
      return createResultError(
        op,
        `Ambiguous hostless/conditional route at ${entry.serverName}/${entry.index}; cannot safely merge host routes.`,
      )
    }
    if (entry.scope.hosts.some((host) => !/^[a-z0-9_.*-]+$/.test(host))) {
      return createResultError(op, `Ambiguous dynamic host matcher at ${entry.serverName}/${entry.index}.`)
    }
    const overlap = [...affectedHosts].filter((host) =>
      entry.scope.hosts.some((pattern) => hostPatternOverlaps(pattern, host)),
    )
    if (overlap.length === 0) continue
    const host = overlap[0]!
    if (!owned.has(host)) return createResultError(op, `Host overlaps an unowned base route: ${host}.`)
    if (
      entry.serverName !== targetServerName ||
      !entry.scope.exclusive ||
      entry.scope.hosts.length !== 1 ||
      entry.scope.hosts[0] !== host ||
      entry.route.group !== undefined
    ) {
      return createResultError(
        op,
        `Ambiguous/shared base route for ${host}; only an exclusive single-host route in the target server can be replaced or deleted.`,
      )
    }
    if (matchedHosts.has(host)) return createResultError(op, `Multiple base routes overlap managed host: ${host}.`)
    matchedHosts.add(host)
    const replacement = generatedByHost.get(host)
    if (replacement !== undefined) {
      if (replacement.scope.hosts.length !== 1 || replacement.route.terminal !== entry.route.terminal) {
        return createResultError(op, `Replacement for ${host} must retain single-host and terminal semantics.`)
      }
      usedGenerated.add(replacement)
    }
    replacements.set(entry.index, replacement)
  }

  const routes: JsonValue[] = []
  for (const [index, route] of (Array.isArray(target.routes) ? target.routes : []).entries()) {
    if (!replacements.has(index)) {
      routes.push(route)
      continue
    }
    const replacement = replacements.get(index)
    if (replacement !== undefined) routes.push(replacement.route)
  }
  for (const entry of generatedRoutes) {
    if (!usedGenerated.has(entry)) routes.push(entry.route)
  }

  // Strip ONLY the generated route array from dependency merging. All other
  // generated fields must be additive or identical, including listeners/TLS/logging.
  const { routes: ignoredRoutes, ...serverDependencies } = generatedServer
  const generatedApps = generated.apps as CaddyJsonObject
  const generatedHttp = generatedApps.http as CaddyJsonObject
  const dependencies: CaddyJsonObject = {
    ...generated,
    apps: {
      ...generatedApps,
      http: {
        ...generatedHttp,
        servers: Object.fromEntries([[targetServerName, serverDependencies]]),
      },
    },
  }
  const mergedR = dependenciesMerge(base, dependencies, "")
  if (!mergedR.success) return mergedR
  const merged = mergedR.data
  const apps = merged.apps as CaddyJsonObject
  const http = apps.http as CaddyJsonObject
  const servers = http.servers as CaddyJsonObject
  return createResult({
    ...merged,
    apps: {
      ...apps,
      http: {
        ...http,
        servers: { ...servers, [targetServerName]: { ...(servers[targetServerName] as CaddyJsonObject), routes } },
      },
    },
  })
}
