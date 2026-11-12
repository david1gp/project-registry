import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { ManagedServiceAuditRecord } from "./ManagedServiceAuditRecord.js"
import type { ManagedServiceFilesystem } from "./ManagedServiceFilesystem.js"

/**
 * Append one JSON line per `svc` action. Registry history is the git log of
 * row files; runtime actions change no row, so they go to this append-only
 * root-owned log instead of empty commits in the row history.
 */
export async function managedServiceAuditAppend(
  filesystem: ManagedServiceFilesystem,
  path: string,
  record: ManagedServiceAuditRecord,
): PromiseResult<void> {
  const op = "managedServiceAuditAppend"
  try {
    await filesystem.append(path, `${JSON.stringify(record)}\n`)
  } catch {
    return createResultErrorCode(op, "managed service audit log is unavailable", "services.unavailable")
  }
  return createResult(undefined)
}
