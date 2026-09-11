import { createResult, createResultErrorCode, type Result } from "#result"
import type { Project } from "./Project.js"
import { projectCaddyEntries } from "./projectCaddyEntries.js"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import { projectLocalCaddyEntries } from "./projectLocalCaddyEntries.js"

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

type ProjectCollisionResource = {
  project: Project
  serviceId: string | undefined
}

function projectCollisionResourceLabel(resource: ProjectCollisionResource): string {
  return resource.serviceId === undefined
    ? projectKey(resource.project)
    : `${projectKey(resource.project)} service ${resource.serviceId}`
}

function projectCollisionLabels(
  previous: ProjectCollisionResource,
  current: ProjectCollisionResource,
): [string, string] {
  if (!projectKeyEqual(previous.project, current.project)) {
    return [projectKey(previous.project), projectKey(current.project)]
  }
  return [projectCollisionResourceLabel(previous), projectCollisionResourceLabel(current)]
}

export function projectCollisions(
  projects: readonly Project[],
  options: ProjectCollisionOptions | ProjectKey = {},
): Result<void> {
  const op = "projectCollisions"
  const keys: Project[] = []
  const ports = new Map<number, ProjectCollisionResource>()
  const domains = new Map<string, ProjectCollisionResource>()

  for (const project of projectCollisionCandidates(projects, options)) {
    const previousKey = keys.find((candidate) => projectKeyEqual(candidate, project))
    if (previousKey && previousKey !== project) {
      return createResultErrorCode(op, `project key collision: ${projectKey(project)}`, "projects.conflict")
    }
    keys.push(project)

    const localEntries = projectLocalCaddyEntries(project)
    for (const entry of projectCaddyEntries(project)) {
      if (entry.caddy.disabled) continue
      const resource = { project, serviceId: entry.serviceId }

      for (const domain of new Set(entry.caddy.domains.map(projectDomainNormalize))) {
        const previous = domains.get(domain)
        if (previous) {
          const [previousLabel, currentLabel] = projectCollisionLabels(previous, resource)
          return createResultErrorCode(
            op,
            `active domain collision: ${domain} used by ${previousLabel} and ${currentLabel}`,
            "projects.conflict",
          )
        }
        domains.set(domain, resource)
      }

      if (!localEntries.some((localEntry) => localEntry.serviceId === entry.serviceId)) continue

      const previous = ports.get(entry.caddy.port)
      if (previous) {
        const [previousLabel, currentLabel] = projectCollisionLabels(previous, resource)
        return createResultErrorCode(
          op,
          `active port collision: ${entry.caddy.port} used by ${previousLabel} and ${currentLabel}`,
          "projects.conflict",
        )
      }
      ports.set(entry.caddy.port, resource)
    }
  }

  return createResult(undefined)
}
