import type { Project } from "./Project.js"
import type { ProjectCaddy } from "./projectCaddySchema.js"
import type { ProjectService } from "./projectServiceSchema.js"

type ProjectCaddyEntry = {
  serviceId?: string
  caddy: ProjectCaddy
}

export function projectCaddyEntries(project: Project): ProjectCaddyEntry[] {
  if (project.schemaVersion === 2) {
    const services = project.services as readonly (string | ProjectService)[]
    const entries: ProjectCaddyEntry[] = []
    for (const service of services) {
      if (typeof service === "string" || service.caddy === undefined || service.caddy === null) continue
      entries.push({ serviceId: service.id, caddy: service.caddy })
    }
    return entries
  }

  if (project.caddy === undefined || project.caddy === null) return []
  return [{ caddy: project.caddy }]
}
