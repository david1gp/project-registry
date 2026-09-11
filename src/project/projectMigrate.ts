import * as a from "valibot"
import { createResult, createResultErrorCode, type Result } from "#result"
import { type ProjectCanonical, projectCanonicalSchema } from "./projectCanonicalSchema.js"
import type { Project } from "./projectSchema.js"
import { projectSchema } from "./projectSchema.js"

const legacyServiceId = "default"

function projectCanonicalFromLegacy(project: Project): ProjectCanonical {
  const { caddy, services, ...metadata } = project
  const hasService = services.length > 0 || (caddy !== undefined && caddy !== null)
  return {
    ...metadata,
    schemaVersion: 2,
    services: hasService
      ? [
          {
            id: legacyServiceId,
            units: services,
            caddy: caddy ?? null,
          },
        ]
      : [],
  }
}

export function projectMigrate(input: unknown): Result<ProjectCanonical> {
  const op = "projectMigrate"
  const canonical = a.safeParse(projectCanonicalSchema, input)
  if (canonical.success) return createResult(canonical.output)

  const legacy = a.safeParse(projectSchema, input)
  if (!legacy.success) return createResultErrorCode(op, a.summarize(legacy.issues), "request.invalid")

  return createResult(projectCanonicalFromLegacy(legacy.output))
}
