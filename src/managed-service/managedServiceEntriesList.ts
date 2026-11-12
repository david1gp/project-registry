import type { Project } from "../project/Project.js"
import { projectMigrate } from "../project/projectMigrate.js"
import type { ManagedServiceEntry } from "./ManagedServiceEntry.js"
import { managedServiceUnitName } from "./managedServiceUnitName.js"

export type ManagedServiceEntries = {
  entries: ManagedServiceEntry[]
  /** Unit names claimed by more than one row (same project name, different owners): never rendered. */
  conflicts: string[]
  /** Rows that declare a managed service but cannot run one (no port, external ownership, bad names). */
  invalid: string[]
}

/**
 * Flatten every row service with a `service` definition into reconcile
 * entries. Pure. Unit names are `proj-<project>-<service>`, so two owners
 * with the same project name collide: both are reported and skipped rather
 * than letting one silently win.
 */
export function managedServiceEntriesList(projects: readonly Project[]): ManagedServiceEntries {
  const byUnit = new Map<string, ManagedServiceEntry[]>()
  const invalid: string[] = []
  for (const project of projects) {
    const canonicalR = projectMigrate(project)
    if (!canonicalR.success) continue
    for (const service of canonicalR.data.services) {
      if (service.service === undefined) continue
      const label = `${project.owner}/${project.name}/${service.id}`
      const unit = managedServiceUnitName(project.name, service.id)
      const caddy = service.caddy
      if (unit === undefined || caddy === null || caddy === undefined || service.ownership === "external") {
        invalid.push(label)
        continue
      }
      const entry: ManagedServiceEntry = {
        owner: project.owner,
        project: project.name,
        serviceId: service.id,
        unit,
        port: caddy.port,
        domains: [...caddy.domains],
        managed: service.service,
      }
      byUnit.set(unit, [...(byUnit.get(unit) ?? []), entry])
    }
  }
  const entries: ManagedServiceEntry[] = []
  const conflicts: string[] = []
  for (const [unit, claimed] of byUnit) {
    if (claimed.length === 1) entries.push(claimed[0]!)
    else conflicts.push(unit)
  }
  entries.sort((left, right) => left.unit.localeCompare(right.unit))
  return { entries, conflicts: conflicts.sort(), invalid: invalid.sort() }
}
