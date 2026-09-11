import type { Project } from "./Project.js"
import { projectLocalCaddyEntries } from "./projectLocalCaddyEntries.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"

export function projectPortCollision(
  projects: readonly Project[],
  port: number,
  excludeKey?: ProjectKey,
): Project | null {
  for (const project of projects) {
    if (excludeKey && projectKeyEqual(project, excludeKey)) continue
    for (const entry of projectLocalCaddyEntries(project)) {
      if (entry.caddy.disabled || entry.caddy.port !== port) continue
      return project
    }
  }
  return null
}
