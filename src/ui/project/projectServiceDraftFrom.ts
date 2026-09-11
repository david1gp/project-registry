import type { ProjectServiceDraft } from "./projectServiceDraftSchema.js"
import type { ProjectServicesService } from "./projectServicesSchema.js"

/** Build editable draft state from an existing service, or blank state for a new service ID. */
export function projectServiceDraftFrom(
  service: ProjectServicesService | undefined,
  serviceId: string,
): ProjectServiceDraft {
  const caddy = service?.caddy ?? null
  return {
    id: service?.id ?? serviceId,
    ownership: service?.ownership ?? "registry",
    port: caddy === null ? "" : String(caddy.port),
    domains: caddy === null ? "" : caddy.domains.join(", "),
    path: caddy?.path ?? "",
    kind: caddy?.kind ?? "proxy",
    access: caddy?.access ?? "external",
    disabled: caddy?.disabled ?? false,
    docs: caddy?.docs ?? true,
    browse: caddy?.browse ?? false,
    spa: caddy?.spa ?? false,
  }
}
