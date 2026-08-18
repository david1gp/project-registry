import * as a from "valibot"
import type { Project } from "../project/Project.js"
import { projectSchema } from "../project/projectSchema.js"
import type { CaddyConfigSummaryEntry } from "./CaddyConfigSummaryEntry.js"

function activeProject(project: Project): project is Project & { caddy: NonNullable<Project["caddy"]> } {
  return project.caddy !== undefined && project.caddy !== null && !project.caddy.disabled
}

function stringCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function validProjects(value: unknown): Project[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = a.safeParse(a.array(projectSchema), value)
  return parsed.success ? parsed.output : undefined
}

export function caddyConfigSummary(projects: readonly Project[]): CaddyConfigSummaryEntry[] {
  let parsed: Project[] | undefined
  try {
    parsed = validProjects(projects)
  } catch {
    return []
  }
  if (parsed === undefined) return []

  return parsed
    .filter(activeProject)
    .sort((left, right) => {
      const domainOrder = left.caddy.domains[0]!.localeCompare(right.caddy.domains[0]!)
      if (domainOrder !== 0) return domainOrder
      const ownerOrder = stringCompare(left.owner, right.owner)
      if (ownerOrder !== 0) return ownerOrder
      return stringCompare(left.name, right.name)
    })
    .map((project) => ({
      owner: project.owner,
      name: project.name,
      port: project.caddy.port,
      kind: project.caddy.kind,
      access: project.caddy.access,
      domains: [...project.caddy.domains],
    }))
}
