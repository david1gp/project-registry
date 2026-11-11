import { join } from "node:path"
import { createResult, type Result } from "#result"
import { projectAccessLogRootValidate } from "../access-log/projectAccessLogRootValidate.js"

/**
 * Shared dev-lease access-log path. Dev leases are synthetic hostnames, not
 * registry rows, so they share one logger outside `projects/` as a sibling
 * directory: the access-log retention reconcile only ever scans `projects/`
 * and `quarantine/`, and only the private Caddy target writes here, so no
 * second Caddy instance ever shares the file.
 */
export function devLeaseAccessLogPath(root: string): Result<string> {
  const rootR = projectAccessLogRootValidate(root)
  if (!rootR.success) return rootR

  return createResult(join(rootR.data, "dev-leases", "access.jsonl"))
}
