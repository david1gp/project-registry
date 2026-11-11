import type { Result } from "#result"
import type { Project } from "../project/Project.js"
import type { ProjectPortRange } from "../project/projectPortNext.js"
import { projectPortNext } from "../project/projectPortNext.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"

export function devPortAllocate(
  projects: readonly Project[],
  leases: readonly DevLeaseRecord[],
  range?: ProjectPortRange,
): Result<number> {
  // Every tracked lease reserves its port until the row is deleted: stopping
  // leases may still be bound while the reaper shuts the unit down.
  const reservedPorts = leases.map((lease) => lease.port)
  return projectPortNext(projects, range, undefined, reservedPorts)
}
