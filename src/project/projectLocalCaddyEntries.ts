import type { Project } from "./Project.js"
import { projectCaddyEntries } from "./projectCaddyEntries.js"
import { projectDomainIsCloudflarePages } from "./projectDomainIsCloudflarePages.js"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import type { ProjectService } from "./projectServiceSchema.js"

export function projectLocalCaddyEntries(project: Project): ReturnType<typeof projectCaddyEntries> {
  const externalServiceIds =
    project.schemaVersion === 2
      ? new Set(
          (project.services as readonly ProjectService[])
            .filter((service) => service.ownership === "external")
            .map((service) => service.id),
        )
      : new Set<string>()

  return projectCaddyEntries(project).flatMap((entry) => {
    if (entry.serviceId !== undefined && externalServiceIds.has(entry.serviceId)) return []
    const domains = entry.caddy.domains.filter(
      (domain) => !projectDomainIsCloudflarePages(projectDomainNormalize(domain)),
    )
    if (domains.length === 0) return []
    return [{ ...entry, caddy: { ...entry.caddy, domains } }]
  })
}
