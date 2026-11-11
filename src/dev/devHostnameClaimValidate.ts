import { createResult, createResultErrorCode, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectCaddyEntries } from "../project/projectCaddyEntries.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"

const devHostnameZone = "wonder1.de"
const devReservedPrefixes = ["t3code-", "opencode-"] as const
const devOwnerPattern = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/
const devProjectPattern = /^[a-z0-9][a-z0-9-]*$/

export function devHostnameClaimValidate(options: {
  user: unknown
  project: unknown
  projects: readonly Project[]
  leases: readonly DevLeaseRecord[]
}): Result<string> {
  const op = "devHostnameClaimValidate"
  if (typeof options !== "object" || options === null) {
    return createResultErrorCode(op, "dev hostname claim is required", "request.invalid")
  }
  const user = typeof options.user === "string" ? options.user : ""
  if (!devOwnerPattern.test(user)) {
    return createResultErrorCode(op, "dev user is invalid", "request.invalid")
  }
  const project = typeof options.project === "string" ? options.project : ""
  if (!devProjectPattern.test(project)) {
    return createResultErrorCode(op, "dev project name is invalid", "request.invalid")
  }
  // The hostname is derived server-side from the socket user and the project
  // name. No zone-policy entry is required: tim/mitarbeiter own no zone yet
  // every dev hostname lives under the shared wonder1.de suffix.
  const hostname = projectDomainNormalize(`${user}-${project}.${devHostnameZone}`)
  if (devReservedPrefixes.some((prefix) => hostname.startsWith(prefix))) {
    return createResultErrorCode(op, `dev hostname "${hostname}" uses a reserved service prefix`, "request.invalid")
  }
  for (const entry of options.projects.flatMap((candidate) => projectCaddyEntries(candidate))) {
    if (entry.caddy.disabled) continue
    for (const domain of entry.caddy.domains) {
      if (projectDomainNormalize(domain) === hostname) {
        return createResultErrorCode(
          op,
          `dev hostname "${hostname}" collides with an existing project domain`,
          "projects.conflict",
        )
      }
    }
  }
  for (const lease of options.leases) {
    const sameHostname = lease.hostname === hostname
    const sameProject = lease.projectKey.owner === user && lease.projectKey.name === project
    if (sameHostname && !sameProject) {
      return createResultErrorCode(
        op,
        `dev hostname "${hostname}" is already leased by ${lease.projectKey.owner}/${lease.projectKey.name}`,
        "projects.conflict",
      )
    }
    if (sameProject && !sameHostname) {
      return createResultErrorCode(
        op,
        `dev project ${user}/${project} already holds a lease for "${lease.hostname}"`,
        "projects.conflict",
      )
    }
  }
  return createResult(hostname)
}
