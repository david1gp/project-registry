import type { ProjectCanonical } from "../project/projectCanonicalSchema.js"
import type { ProjectService } from "../project/projectServiceSchema.js"

/**
 * Flatten one canonical project into one human/JSON row per service so the CLI
 * presents every routed service of a project instead of a single Caddy record.
 */
export function projectCliServiceRows(project: ProjectCanonical): Record<string, unknown>[] {
  const services: readonly (ProjectService | undefined)[] = project.services.length > 0 ? project.services : [undefined]
  return services.map((service) => {
    const caddy = service?.caddy
    return {
      name: project.name,
      user: project.owner,
      ...(service === undefined ? {} : { service: service.id }),
      ...(service === undefined ? {} : { ownership: service.ownership ?? "registry" }),
      port: caddy?.port,
      domains: caddy?.domains ?? [],
      path: caddy?.path ?? "",
      access: caddy?.access ?? "external",
      kind: caddy?.kind ?? "proxy",
      docs: caddy?.docs ?? false,
      browse: caddy?.browse ?? false,
      headerUp: caddy?.headerUp ?? {},
      disabled: caddy?.disabled ?? true,
      routed: caddy?.routed,
      oidcPaths: caddy?.oidcPaths,
      docsPath: caddy?.docsPath,
      browseTemplate: caddy?.browseTemplate,
      staticAllow: caddy?.staticAllow,
      denyDotfiles: caddy?.denyDotfiles,
      spa: caddy?.spa,
      flushInterval: caddy?.flushInterval,
      units: service?.units ?? [],
      labels: project.labels,
    }
  })
}
