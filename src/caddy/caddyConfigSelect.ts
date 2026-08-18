import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectKey } from "../project/projectKey.js"
import { projectSchema } from "../project/projectSchema.js"
import type { CaddyConfig } from "./CaddyConfig.js"

type RouteRecord = Record<string, unknown>

function activeProject(project: Project): project is Project & { caddy: NonNullable<Project["caddy"]> } {
  return project.caddy !== undefined && project.caddy !== null && !project.caddy.disabled
}

function stringCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function projectCompare(
  left: Project & { caddy: NonNullable<Project["caddy"]> },
  right: Project & { caddy: NonNullable<Project["caddy"]> },
): number {
  const domainOrder = left.caddy.domains[0]!.localeCompare(right.caddy.domains[0]!)
  if (domainOrder !== 0) return domainOrder
  const ownerOrder = stringCompare(left.owner, right.owner)
  if (ownerOrder !== 0) return ownerOrder
  return stringCompare(left.name, right.name)
}

function projectsParse(value: unknown): Project[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = a.safeParse(a.array(projectSchema), value)
  return parsed.success ? parsed.output : undefined
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
  return createResultError("caddyConfigSelect", "no server block matching selector")
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

    const active = parsedProjects.filter(activeProject).sort(projectCompare)
    const visibleDomains = new Set(
      active.flatMap((project) => project.caddy.domains.map((domain) => domain.toLowerCase())),
    )
    const scopedRoutes = routes.filter((route) => {
      const hosts = routeHosts(route)
      return hosts.length > 0 && hosts.every((host) => visibleDomains.has(host.toLowerCase()))
    })
    const selectorLower = selector.toLowerCase()

    const parsedSelector = selectorKey(selector)
    if (parsedSelector?.kind === "invalid-canonical") return error()

    const keyMatches =
      parsedSelector?.kind === "canonical" || parsedSelector?.kind === "legacy"
        ? active.filter((project) => project.owner === parsedSelector.owner && project.name === parsedSelector.name)
        : []
    const matches =
      keyMatches.length > 0
        ? keyMatches
        : parsedSelector?.kind === "canonical"
          ? []
          : (() => {
              const port = /^\d+$/.test(selector) ? Number(selector) : undefined
              return active.filter(
                (project) =>
                  project.name.toLowerCase() === selectorLower ||
                  (port !== undefined && project.caddy.port === port) ||
                  project.caddy.domains.some((domain) => domain.toLowerCase() === selectorLower),
              )
            })()

    if (matches.length !== 1) return error()
    const domains = [...matches[0]!.caddy.domains]

    const domainSet = new Set(domains.map((domain) => domain.toLowerCase()))
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
