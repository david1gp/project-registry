import * as a from "valibot"
import { createResult, createResultErrorCode, type Result } from "#result"
import type { ProjectCanonicalNormalizeOptions } from "./ProjectCanonicalNormalizeOptions.js"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"
import { projectCanonicalSchema } from "./projectCanonicalSchema.js"
import { projectCollisions } from "./projectCollisions.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectNormalize } from "./projectNormalize.js"

function canonicalInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = { ...(input as Record<string, unknown>) }
  delete record.expectedRevision
  return record
}

export function projectCanonicalNormalize(
  input: unknown,
  options: ProjectCanonicalNormalizeOptions = {},
): Result<ProjectCanonical> {
  const op = "projectCanonicalNormalize"
  const record =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  if (record?.schemaVersion === 2) {
    const parsed = a.safeParse(projectCanonicalSchema, canonicalInput(input))
    if (!parsed.success) return createResultErrorCode(op, a.summarize(parsed.issues), "request.invalid")
    const migrated = projectMigrate(parsed.output)
    if (!migrated.success) return { ...migrated, op }
    const collisions = projectCollisions(options.projects ?? [], {
      excludeKey: options.excludeKey,
      excludeProject: options.excludeProject,
      replacement: migrated.data,
    })
    if (!collisions.success) return { ...collisions, op }
    return createResult(migrated.data)
  }

  const legacyR = projectNormalize(input, options)
  if (!legacyR.success) return { ...legacyR, op }
  const migrated = projectMigrate(legacyR.data)
  if (!migrated.success) return { ...migrated, op }
  return createResult(migrated.data)
}
