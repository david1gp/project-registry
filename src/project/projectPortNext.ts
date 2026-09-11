import { createResult, createResultErrorCode, type Result } from "#result"
import type { Project } from "./Project.js"
import { projectCaddyEntries } from "./projectCaddyEntries.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"

export type ProjectPortRange = {
  from: number
  to: number
}

const defaultPortRange: ProjectPortRange = { from: 3000, to: 3999 }

function projectPortRangeValidate(range: ProjectPortRange): string | undefined {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) return "port range bounds must be integers"
  if (range.from < 1 || range.to > 65535) return "port range bounds must be between 1 and 65535"
  if (range.from > range.to) return "port range start must not exceed its end"
  return undefined
}

export function projectPortNext(
  projects: readonly Project[],
  range: ProjectPortRange = defaultPortRange,
  excludeKey?: ProjectKey,
): Result<number> {
  const op = "projectPortNext"
  const rangeError = projectPortRangeValidate(range)
  if (rangeError) return createResultErrorCode(op, rangeError, "request.invalid")

  const used = new Set<number>()
  for (const project of projects) {
    if (excludeKey && projectKeyEqual(project, excludeKey)) continue
    for (const entry of projectCaddyEntries(project)) {
      if (entry.caddy.disabled) continue
      used.add(entry.caddy.port)
    }
  }

  for (let port = range.from; port <= range.to; port += 1) {
    if (!used.has(port)) return createResult(port)
  }

  return createResultErrorCode(op, `no free port in range ${range.from}-${range.to}`, "request.invalid")
}
