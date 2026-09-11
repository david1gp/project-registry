import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectCaddyEntries } from "../project/projectCaddyEntries.js"
import type { ProjectCaddy } from "../project/projectCaddySchema.js"
import type { ProjectCanonical } from "../project/projectCanonicalSchema.js"
import { projectKey } from "../project/projectKey.js"
import { projectMigrate } from "../project/projectMigrate.js"
import type { CaddyConfig } from "./CaddyConfig.js"

type RouteRecord = Record<string, unknown>

type CaddyProjectRoute = {
  project: ProjectCanonical
  serviceId?: string
  caddy: ProjectCaddy
}

function projectRoutes(project: ProjectCanonical): CaddyProjectRoute[] {
  return projectCaddyEntries(project).map((entry) => ({ project, serviceId: entry.serviceId, caddy: entry.caddy }))
}

function stringCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function projectsParse(value: unknown): ProjectCanonical[] | undefined {
  if (!Array.isArray(value)) return undefined

  const projects: ProjectCanonical[] = []
  for (const project of value) {
    const migrated = projectMigrate(project)
    if (!migrated.success) return undefined
    projects.push(migrated.data)
  }
  return projects
}

function activeRoutes(projects: readonly ProjectCanonical[]): CaddyProjectRoute[] {
  return projects
    .flatMap(projectRoutes)
    .filter((route) => !route.caddy.disabled)
    .sort((left, right) => {
      const domainOrder = left.caddy.domains[0]!.localeCompare(right.caddy.domains[0]!)
      if (domainOrder !== 0) return domainOrder
      const ownerOrder = stringCompare(left.project.owner, right.project.owner)
      if (ownerOrder !== 0) return ownerOrder
      const nameOrder = stringCompare(left.project.name, right.project.name)
      if (nameOrder !== 0) return nameOrder
      return stringCompare(left.serviceId ?? "", right.serviceId ?? "")
    })
}

function uniqueProjects(routes: readonly CaddyProjectRoute[]): ProjectCanonical[] {
  const projects: ProjectCanonical[] = []
  for (const route of routes) {
    if (!projects.includes(route.project)) projects.push(route.project)
  }
  return projects
}

function recordValue(value: unknown): RouteRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as RouteRecord
}

function routesParse(config: unknown): RouteRecord[] | undefined {
  const root = recordValue(config)
  const apps = recordValue(root?.apps)
  const http = recordValue(apps?.http)
  const servers = recordValue(http?.servers)
  const server = recordValue(servers?.srv0)
  if (!Array.isArray(server?.routes)) return undefined
  if (server.routes.some((route) => recordValue(route) === undefined)) return undefined
  return server.routes as RouteRecord[]
}

function routeHosts(route: RouteRecord): string[] {
  const match = Array.isArray(route.match) ? route.match[0] : undefined
  const matchRecord = recordValue(match)
  const hosts = matchRecord?.host
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string")) return []
  return hosts as string[]
}

function error(): Result<unknown[]> {
  return createResultErrorCode("caddyConfigSelect", "no server block matching selector", "caddy.not-found")
}

type ParsedSelector =
  | { kind: "canonical"; owner: string; name: string }
  | { kind: "legacy"; owner: string; name: string }
  | { kind: "invalid-canonical" }

function selectorKey(selector: string): ParsedSelector | undefined {
  if (selector.startsWith("[") && selector.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(selector)
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === "string" &&
        typeof parsed[1] === "string" &&
        projectKey({ owner: parsed[0], name: parsed[1] }) === selector
      ) {
        return { kind: "canonical", owner: parsed[0], name: parsed[1] }
      }
    } catch {
      return { kind: "invalid-canonical" }
    }
    return { kind: "invalid-canonical" }
  }

  const separator = selector.lastIndexOf("/")
  if (separator <= 0 || separator === selector.length - 1) return undefined
  return { kind: "legacy", owner: selector.slice(0, separator), name: selector.slice(separator + 1) }
}

export function caddyConfigSelect(
  config: CaddyConfig,
  projects: readonly Project[],
  selector: string,
): Result<unknown[]> {
  const op = "caddyConfigSelect"
  try {
    const parsedProjects = projectsParse(projects)
    if (parsedProjects === undefined) return createResultError(op, "visible project snapshot is invalid")
    if (typeof selector !== "string" || selector.length === 0) return error()

    const routes = routesParse(config)
    if (routes === undefined) return createResultError(op, "Caddy configuration is invalid")

    const active = activeRoutes(parsedProjects)
    const visibleDomains = new Set(active.flatMap((route) => route.caddy.domains.map((domain) => domain.toLowerCase())))
    const scopedRoutes = routes.filter((route) => {
      const hosts = routeHosts(route)
      return hosts.length > 0 && hosts.every((host) => visibleDomains.has(host.toLowerCase()))
    })
    const selectorLower = selector.toLowerCase()

    const parsedSelector = selectorKey(selector)
    if (parsedSelector?.kind === "invalid-canonical") return error()

    let matchedRoutes: CaddyProjectRoute[]
    if (parsedSelector?.kind === "canonical" || parsedSelector?.kind === "legacy") {
      const matches = active.filter(
        (route) => route.project.owner === parsedSelector.owner && route.project.name === parsedSelector.name,
      )
      const matchedProjects = uniqueProjects(matches)
      if (matchedProjects.length !== 1) return error()
      matchedRoutes = active.filter((route) => route.project === matchedProjects[0])
    } else {
      const nameMatches = uniqueProjects(active.filter((route) => route.project.name.toLowerCase() === selectorLower))
      const port = /^\d+$/.test(selector) ? Number(selector) : undefined
      const routeMatches = active.filter(
        (route) =>
          (port !== undefined && route.caddy.port === port) ||
          route.caddy.domains.some((domain) => domain.toLowerCase() === selectorLower),
      )
      const matchedProjects = uniqueProjects([
        ...nameMatches.flatMap((project) => projectRoutes(project)),
        ...routeMatches,
      ])
      if (matchedProjects.length !== 1) return error()
      matchedRoutes =
        nameMatches.length > 0 ? active.filter((route) => route.project === matchedProjects[0]) : routeMatches
    }

    if (matchedRoutes.length === 0) return error()
    const domainSet = new Set(
      matchedRoutes.flatMap((route) => route.caddy.domains.map((domain) => domain.toLowerCase())),
    )
    const matched = scopedRoutes.filter((route) => {
      const hosts = routeHosts(route)
      return hosts.some((host) => domainSet.has(host.toLowerCase()))
    })
    if (matched.length === 0) return error()
    return createResult(matched)
  } catch {
    return createResultError(op, "Caddy configuration is invalid")
  }
}
