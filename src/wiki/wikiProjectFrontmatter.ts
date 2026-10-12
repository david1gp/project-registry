import type { ProjectCanonical } from "../project/projectCanonicalSchema.js"

function wikiProjectFrontmatterText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return value.trim() === "" ? undefined : value
}

export function wikiProjectFrontmatterBuild(project: ProjectCanonical): Record<string, unknown> {
  const managed: Record<string, unknown> = {
    projectRegistry: structuredClone(project),
    owner: project.owner,
    name: project.name,
  }

  const displayName = wikiProjectFrontmatterText(project.displayName)
  if (displayName !== undefined) managed.displayName = displayName

  const section = wikiProjectFrontmatterText(project.labels.section)
  if (section !== undefined) managed.section = section

  const customerName = wikiProjectFrontmatterText(project.labels.customerName)
  if (customerName !== undefined) managed.customerName = customerName

  const customerEmail = wikiProjectFrontmatterText(project.labels.customerEmail)
  if (customerEmail !== undefined) managed.customerEmail = customerEmail

  // Actual dev/production URLs come only from the authoritative canonical
  // fields. Domain strings alone cannot prove a role (*.pages.dev hosts
  // dev/preview deployments too), so uncertain roles are omitted while the
  // complete projectRegistry snapshot plus serviceDomains keep every domain.
  const previewUrl = wikiProjectFrontmatterText(project.previewUrl)
  if (previewUrl !== undefined) managed.previewUrl = previewUrl

  const previewPort = wikiProjectFrontmatterText(project.previewPort)
  if (previewPort !== undefined) managed.previewPort = previewPort

  const productionUrl = wikiProjectFrontmatterText(project.productionUrl)
  if (productionUrl !== undefined) managed.productionUrl = productionUrl

  const productionAssetsUrl = wikiProjectFrontmatterText(project.productionAssetsUrl)
  if (productionAssetsUrl !== undefined) managed.productionAssetsUrl = productionAssetsUrl

  const serviceDomains = [
    ...new Set(
      project.services
        .flatMap((service) => service.caddy?.domains ?? [])
        .map((domain) => domain.trim())
        .filter(Boolean),
    ),
  ].sort()
  if (serviceDomains.length > 0) managed.serviceDomains = serviceDomains

  return managed
}
