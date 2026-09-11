import * as a from "valibot"
import { createResult, createResultErrorCode, type Result } from "#result"
import { projectMigrate } from "./projectMigrate.js"
import type { Project } from "./projectSchema.js"
import { projectSchema } from "./projectSchema.js"

export function projectCanonicalToLegacy(input: unknown): Result<Project> {
  const op = "projectCanonicalToLegacy"
  const migrated = projectMigrate(input)
  if (!migrated.success) return migrated

  const { schemaVersion: _schemaVersion, services: _services, ...metadata } = migrated.data
  const service = migrated.data.services.find((candidate) => candidate.id === "default") ?? migrated.data.services[0]
  const legacy: Record<string, unknown> = {
    ...metadata,
    schemaVersion: 1,
    services: service?.units ?? [],
  }
  if (service !== undefined) legacy.caddy = service.caddy

  const parsed = a.safeParse(projectSchema, legacy)
  if (!parsed.success) return createResultErrorCode(op, a.summarize(parsed.issues), "request.invalid")
  return createResult(parsed.output)
}
