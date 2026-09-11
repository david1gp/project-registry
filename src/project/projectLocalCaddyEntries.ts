import type { Project } from "./Project.js"
import { projectCaddyEntries } from "./projectCaddyEntries.js"
import type { ProjectService } from "./projectServiceSchema.js"

export function projectLocalCaddyEntries(project: Project): ReturnType<typeof projectCaddyEntries> {
  if (project.schemaVersion !== 2) return projectCaddyEntries(project)

  const services = project.services as readonly ProjectService[]
  const externalServiceIds = new Set(
    services.filter((service) => service.ownership === "external").map((service) => service.id),
  )
  return projectCaddyEntries(project).filter(
    (entry) => entry.serviceId === undefined || !externalServiceIds.has(entry.serviceId),
  )
}
