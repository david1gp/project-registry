import { createResult, createResultError, type Result } from "#result"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import type { Project } from "./projectSchema.js"

export type ProjectCollisionOptions = {
  excludeKey?: ProjectKey
  excludeProject?: Project
  replacement?: Project
}

function projectCollisionExcludeKey(options: ProjectCollisionOptions | ProjectKey): ProjectKey | undefined {
  if ("owner" in options && "name" in options) return options
  return options.excludeKey
}

function projectCollisionProjectIsExcluded(project: Project, options: ProjectCollisionOptions | ProjectKey): boolean {
  if ("owner" in options && "name" in options) {
    return projectKeyEqual(project, options)
  }
  if (options.excludeProject !== undefined) return projectKeyEqual(project, options.excludeProject)
  const excludeKey = projectCollisionExcludeKey(options)
  return excludeKey !== undefined && projectKeyEqual(project, excludeKey)
}

function projectCollisionCandidates(
  projects: readonly Project[],
  options: ProjectCollisionOptions | ProjectKey,
): Project[] {
  let excluded = false
  const candidates = projects.filter((project) => {
    if (excluded || !projectCollisionProjectIsExcluded(project, options)) return true
    excluded = true
    return false
  })
  if ("owner" in options && "name" in options) return candidates
  if (options.replacement === undefined) return candidates
  return [...candidates, options.replacement]
}

function projectActive(project: Project): boolean {
  return project.caddy !== undefined && project.caddy !== null && !project.caddy.disabled
}

export function projectCollisions(
  projects: readonly Project[],
  options: ProjectCollisionOptions | ProjectKey = {},
): Result<void> {
  const op = "projectCollisions"
  const keys: Project[] = []
  const ports = new Map<number, Project>()
  const domains = new Map<string, Project>()

  for (const project of projectCollisionCandidates(projects, options)) {
    const previousKey = keys.find((candidate) => projectKeyEqual(candidate, project))
    if (previousKey && previousKey !== project) {
      return createResultError(op, `project key collision: ${projectKey(project)}`)
    }
    keys.push(project)

    if (!projectActive(project)) continue
    const caddy = project.caddy
    if (caddy === undefined || caddy === null) continue

    for (const domain of new Set(caddy.domains.map(projectDomainNormalize))) {
      const previous = domains.get(domain)
      if (previous && !projectKeyEqual(previous, project)) {
        return createResultError(
          op,
          `active domain collision: ${domain} used by ${projectKey(previous)} and ${projectKey(project)}`,
        )
      }
      domains.set(domain, project)
    }

    const previous = ports.get(caddy.port)
    if (previous && !projectKeyEqual(previous, project)) {
      return createResultError(
        op,
        `active port collision: ${caddy.port} used by ${projectKey(previous)} and ${projectKey(project)}`,
      )
    }
    ports.set(caddy.port, project)
  }

  return createResult(undefined)
}
