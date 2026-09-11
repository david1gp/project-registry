import { projectLocalCaddyEntries } from "../project/projectLocalCaddyEntries.js"
import type { ProjectCaddy } from "../project/projectCaddySchema.js"
import type { ProjectCanonical } from "../project/projectCanonicalSchema.js"
import { projectMigrate } from "../project/projectMigrate.js"
import type { CaddyConfigSummaryEntry } from "./CaddyConfigSummaryEntry.js"

type CaddySummaryRoute = {
  project: ProjectCanonical
  serviceId?: string
  caddy: ProjectCaddy
}

function projectRoutes(project: ProjectCanonical): CaddySummaryRoute[] {
  return projectLocalCaddyEntries(project).map((entry) => ({ project, serviceId: entry.serviceId, caddy: entry.caddy }))
}

function validProjects(value: unknown): ProjectCanonical[] | undefined {
  if (!Array.isArray(value)) return undefined

  const projects: ProjectCanonical[] = []
  for (const project of value) {
    const migrated = projectMigrate(project)
    if (!migrated.success) return undefined
    projects.push(migrated.data)
  }
  return projects
}

export function caddyConfigSummary(projects: readonly ProjectCanonical[]): CaddyConfigSummaryEntry[] {
  let parsed: ProjectCanonical[] | undefined
  try {
    parsed = validProjects(projects)
  } catch {
    return []
  }
  if (parsed === undefined) return []

  return parsed
    .flatMap(projectRoutes)
    .filter((route) => !route.caddy.disabled)
    .sort((left, right) => {
      const domainOrder = left.caddy.domains[0]!.localeCompare(right.caddy.domains[0]!)
      if (domainOrder !== 0) return domainOrder
      const ownerOrder = left.project.owner.localeCompare(right.project.owner)
      if (ownerOrder !== 0) return ownerOrder
      const nameOrder = left.project.name.localeCompare(right.project.name)
      if (nameOrder !== 0) return nameOrder
      return (left.serviceId ?? "").localeCompare(right.serviceId ?? "")
    })
    .map((route) => ({
      owner: route.project.owner,
      name: route.project.name,
      port: route.caddy.port,
      kind: route.caddy.kind,
      access: route.caddy.access,
      domains: [...route.caddy.domains],
    }))
}
