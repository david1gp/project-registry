import { projectDomainNormalize } from "./projectDomainNormalize.js"

export function projectDomainIsCloudflarePages(domain: string): boolean {
  const normalized = projectDomainNormalize(domain)
  return normalized.length > ".pages.dev".length && normalized.endsWith(".pages.dev")
}
