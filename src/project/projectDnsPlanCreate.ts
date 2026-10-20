import { createResult, createResultError, type Result } from "#result"
import { projectCaddyEntries } from "./projectCaddyEntries.js"
import { projectDomainIsCloudflarePages } from "./projectDomainIsCloudflarePages.js"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import type { Project } from "./Project.js"
import type { ProjectService } from "./projectServiceSchema.js"

export type ProjectDnsPlan = {
  publicHostnames: string[]
  privateHostnames: string[]
  protectedHostnames: string[]
}

export function projectDnsPlanCreate(projects: readonly Project[]): Result<ProjectDnsPlan> {
  const op = "projectDnsPlanCreate"
  if (!Array.isArray(projects)) return createResultError(op, "Project DNS plan projects are invalid")
  const publicHostnames = new Set<string>()
  const privateHostnames = new Set<string>()
  const protectedHostnames = new Set<string>()
  const externalProtectedHostnames = new Set<string>()
  for (const project of projects) {
    if (typeof project !== "object" || project === null) {
      return createResultError(op, "Project DNS plan projects are invalid")
    }
    const externalServiceIds =
      project.schemaVersion === 2
        ? new Set(
            (project.services as readonly ProjectService[])
              .filter((service) => service.ownership === "external")
              .map((service) => service.id),
          )
        : new Set<string>()
    for (const entry of projectCaddyEntries(project)) {
      if (entry.caddy.disabled) continue
      const visibility =
        (entry.caddy as { networkVisibility?: unknown }).networkVisibility === "private" ? "private" : "public"
      for (const domain of entry.caddy.domains) {
        const normalized = projectDomainNormalize(domain)
        if (normalized === "") continue
        if (projectDomainIsCloudflarePages(normalized)) {
          protectedHostnames.add(normalized)
          continue
        }
        if (entry.serviceId !== undefined && externalServiceIds.has(entry.serviceId)) {
          protectedHostnames.add(normalized)
          externalProtectedHostnames.add(normalized)
          continue
        }
        if (visibility === "private") privateHostnames.add(normalized)
        else publicHostnames.add(normalized)
      }
    }
  }
  const conflicts = [...publicHostnames].filter((hostname) => privateHostnames.has(hostname)).sort()
  if (conflicts.length > 0) {
    return createResultError(op, `Conflicting public/private DNS claims for ${conflicts.join(", ")}`)
  }
  const publicProtectedConflicts = [...publicHostnames]
    .filter((hostname) => externalProtectedHostnames.has(hostname))
    .sort()
  if (publicProtectedConflicts.length > 0) {
    return createResultError(op, `Conflicting public/protected DNS claims for ${publicProtectedConflicts.join(", ")}`)
  }
  const privateProtectedConflicts = [...privateHostnames]
    .filter((hostname) => externalProtectedHostnames.has(hostname))
    .sort()
  if (privateProtectedConflicts.length > 0) {
    return createResultError(op, `Conflicting private/protected DNS claims for ${privateProtectedConflicts.join(", ")}`)
  }
  return createResult({
    publicHostnames: [...publicHostnames].sort(),
    privateHostnames: [...privateHostnames].sort(),
    protectedHostnames: [...protectedHostnames].sort(),
  })
}
