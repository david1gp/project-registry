import * as a from "valibot"
import { createResult, createResultErrorCode, type Result } from "#result"
import { projectClassificationNormalize } from "./projectClassificationNormalize.js"
import type { ProjectClassificationType } from "./projectClassificationType.js"
import { type ProjectCanonical, projectCanonicalSchema } from "./projectCanonicalSchema.js"
import type { ProjectLegacyPersisted } from "./projectLegacyPersistedSchema.js"
import { projectLegacyPersistedSchema } from "./projectLegacyPersistedSchema.js"

const legacyServiceId = "default"

function projectCanonicalOwnershipNormalize(project: ProjectCanonical): ProjectCanonical {
  return {
    ...project,
    services: project.services.map((service) => ({
      ...service,
      ownership: service.ownership ?? "registry",
    })),
  }
}

function projectCanonicalFromLegacy(project: ProjectLegacyPersisted): ProjectCanonical {
  const { caddy, services, type, labels, ...metadata } = project
  const hasService = services.length > 0 || (caddy !== undefined && caddy !== null)
  return {
    ...metadata,
    schemaVersion: 2,
    labels: projectClassificationNormalize(labels, type),
    services: hasService
      ? [
          {
            id: legacyServiceId,
            units: services,
            caddy: caddy ?? null,
            ownership: "registry",
          },
        ]
      : [],
  }
}

function projectCanonicalFromPersisted(input: unknown): Result<ProjectCanonical> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  if (record.schemaVersion !== 2) return undefined

  let type: ProjectClassificationType | undefined
  if (Object.hasOwn(record, "type")) {
    const typeR = a.safeParse(a.optional(a.picklist(["own", "internal", "customer"])), record.type)
    if (!typeR.success) return createResultErrorCode("projectMigrate", a.summarize(typeR.issues), "request.invalid")
    type = typeR.output
  }

  const canonicalRecord = { ...record }
  delete canonicalRecord.type
  const canonical = a.safeParse(projectCanonicalSchema, canonicalRecord)
  if (!canonical.success) return undefined
  return createResult(
    projectCanonicalOwnershipNormalize({
      ...canonical.output,
      labels: projectClassificationNormalize(canonical.output.labels, type),
    }),
  )
}

export function projectMigrate(input: unknown): Result<ProjectCanonical> {
  const op = "projectMigrate"
  const persistedCanonical = projectCanonicalFromPersisted(input)
  if (persistedCanonical !== undefined) return persistedCanonical

  const legacy = a.safeParse(projectLegacyPersistedSchema, input)
  if (!legacy.success) return createResultErrorCode(op, a.summarize(legacy.issues), "request.invalid")

  return createResult(projectCanonicalFromLegacy(legacy.output))
}
