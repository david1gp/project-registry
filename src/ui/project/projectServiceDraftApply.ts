import * as v from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { type ProjectServiceDraft, projectServiceDraftSchema } from "./projectServiceDraftSchema.js"
import type { ProjectServicesService } from "./projectServicesSchema.js"

function domainsParse(input: string): string[] {
  return [
    ...new Set(
      input
        .split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain !== ""),
    ),
  ]
}

/**
 * Apply an edited draft onto the canonical service collection, replacing only the edited
 * service and preserving every sibling service with its own domains, port, and Caddy settings.
 */
export function projectServiceDraftApply(
  services: readonly ProjectServicesService[],
  draft: ProjectServiceDraft,
): Result<ProjectServicesService[]> {
  const op = "projectServiceDraftApply"
  const parsed = v.safeParse(projectServiceDraftSchema, draft)
  if (!parsed.success) return createResultError(op, v.summarize(parsed.issues))

  const port = Number(parsed.output.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return createResultError(op, "Der Port muss eine Zahl von 1 bis 65535 sein.")
  }

  const domains = domainsParse(parsed.output.domains)
  if (domains.length === 0) return createResultError(op, "Mindestens eine Domain ist erforderlich.")

  const existing = services.find((service) => service.id === parsed.output.id)
  const caddy = {
    ...(existing?.caddy ?? {}),
    port,
    domains,
    path: parsed.output.path,
    kind: parsed.output.kind,
    access: parsed.output.access,
    disabled: parsed.output.disabled,
    docs: parsed.output.docs,
    browse: parsed.output.browse,
    spa: parsed.output.spa,
  } as NonNullable<ProjectServicesService["caddy"]>

  if (existing === undefined) {
    return createResult([
      ...services,
      { id: parsed.output.id, units: [], caddy, ownership: parsed.output.ownership ?? "registry" },
    ])
  }
  return createResult(
    services.map((service) =>
      service.id === existing.id
        ? { ...service, caddy, ownership: parsed.output.ownership ?? service.ownership ?? "registry" }
        : service,
    ),
  )
}
