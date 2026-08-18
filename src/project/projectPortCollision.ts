import type { ProjectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import type { Project } from "./projectSchema.js"

export function projectPortCollision(
  projects: readonly Project[],
  port: number,
  excludeKey?: ProjectKey,
): Project | null {
  for (const project of projects) {
    if (excludeKey && projectKeyEqual(project, excludeKey)) continue
    if (!project.caddy || project.caddy.disabled || project.caddy.port !== port) continue
    return project
  }
  return null
}
