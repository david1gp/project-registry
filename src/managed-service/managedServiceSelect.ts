import { createResult, createResultErrorCode, type Result } from "#result"
import type { ManagedServiceEntry } from "./ManagedServiceEntry.js"
import type { ManagedServiceEntries } from "./managedServiceEntriesList.js"

/**
 * Pick the managed services of `<project>` (any owner). With `serviceId`,
 * exactly that one; without it, all of them when `many` is allowed (status),
 * otherwise exactly one must exist.
 */
export function managedServiceSelect(
  listed: ManagedServiceEntries,
  project: string,
  serviceId: string | undefined,
  many: boolean,
): Result<ManagedServiceEntry[]> {
  const op = "managedServiceSelect"
  const conflict = listed.conflicts.find((unit) => unit.startsWith(`proj-${project}-`))
  const matches = listed.entries.filter(
    (entry) => entry.project === project && (serviceId === undefined || entry.serviceId === serviceId),
  )
  if (matches.length === 0) {
    if (conflict !== undefined) {
      return createResultErrorCode(op, `${conflict} is claimed by more than one owner`, "projects.conflict")
    }
    const target = serviceId === undefined ? project : `${project} --service ${serviceId}`
    return createResultErrorCode(op, `No managed service for ${target}.`, "services.not-found")
  }
  if (!many && matches.length > 1) {
    return createResultErrorCode(
      op,
      `Project ${project} has several managed services (${matches.map((entry) => entry.serviceId).join(", ")}); pass --service <id>.`,
      "projects.conflict",
    )
  }
  return createResult(matches)
}
