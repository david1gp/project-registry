import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectFilter } from "../project/projectFilter.js"
import { projectLabelsSchema } from "../project/projectLabelsSchema.js"
import { projectServiceOwnershipSchema } from "../project/projectServiceOwnershipSchema.js"
import { projectRegistryVersion } from "../projectRegistryVersion.js"
import {
  type ProjectRegistryDaemonCloudflareDnsStatus,
  projectRegistryDaemonCloudflareDnsStatusSchema,
} from "../runtime/projectRegistryDaemonCloudflareDnsStatusSchema.js"
import {
  type ProjectRegistryDaemonPrivateDnsStatus,
  projectRegistryDaemonPrivateDnsStatusSchema,
} from "../runtime/projectRegistryDaemonPrivateDnsStatusSchema.js"
import {
  type ProjectRegistryDaemonPrivateTlsStatus,
  projectRegistryDaemonPrivateTlsStatusSchema,
} from "../runtime/projectRegistryDaemonPrivateTlsStatusSchema.js"
import type { ProjectRegistryCliInvocation } from "./ProjectRegistryCliInvocation.js"

const projectSchema = a.looseObject({
  name: a.string(),
  user: a.string(),
  service: a.optional(a.string()),
  ownership: a.optional(projectServiceOwnershipSchema, "registry"),
  port: a.optional(a.number()),
  domains: a.array(a.string()),
  kind: a.picklist(["proxy", "static"]),
  labels: a.optional(projectLabelsSchema, {}),
})

function projectOutputNormalize(project: a.InferOutput<typeof projectSchema>): a.InferOutput<typeof projectSchema> {
  const { type: _type, ...withoutLegacyType } = project as typeof project & { type?: unknown }
  return withoutLegacyType
}
const historyEntrySchema = a.looseObject({
  sha: a.string(),
  date: a.string(),
  author: a.string(),
  message: a.string(),
})
const statusSchema = a.looseObject({
  desiredRevision: a.optional(a.string()),
  appliedRevision: a.optional(a.string()),
  pendingRevision: a.optional(a.string()),
  pending: a.boolean(),
  lastAttempt: a.optional(a.number()),
  lastSuccess: a.optional(a.number()),
  error: a.optional(a.string()),
  cloudflareDns: a.optional(projectRegistryDaemonCloudflareDnsStatusSchema),
  privateDns: a.optional(projectRegistryDaemonPrivateDnsStatusSchema),
  privateTls: a.optional(projectRegistryDaemonPrivateTlsStatusSchema),
})
const mutationSchema = a.looseObject({
  action: a.picklist(["create", "edit", "delete"]),
  key: a.object({ owner: a.string(), name: a.string() }),
  changed: a.boolean(),
  revision: a.string(),
  localCommit: a.looseObject({ status: a.picklist(["committed", "unchanged"]), revision: a.string() }),
  push: a.looseObject({
    requested: a.boolean(),
    status: a.picklist(["not-requested", "pushed", "failed"]),
    errorMessage: a.optional(a.string()),
  }),
})
const userDefaultDomainSchema = a.looseObject({
  owner: a.string(),
  domain: a.nullable(a.string()),
  source: a.picklist(["explicit", "environment", "none"]),
  revision: a.string(),
})
const userDefaultDomainMutationSchema = a.looseObject({
  action: a.picklist(["set", "unset"]),
  owner: a.string(),
  domain: a.nullable(a.string()),
  changed: a.boolean(),
  revision: a.string(),
  localCommit: a.looseObject({ status: a.picklist(["committed", "unchanged"]), revision: a.string() }),
  push: a.looseObject({
    requested: a.boolean(),
    status: a.picklist(["not-requested", "pushed", "failed"]),
    errorMessage: a.optional(a.string()),
  }),
})
const cloudflareTokenMutationSchema = a.object({ updated: a.literal(true) })
const legacyDeleteSchema = a.object({ deleted: a.string() })
const docsSchema = a.object({ urls: a.array(a.string()) })
const docsPublicationSchema = a.object({
  project: a.string(),
  file: a.string(),
  index: a.string(),
  urls: a.array(a.string()),
  indexUrls: a.array(a.string()),
})
const regenerateSchema = a.looseObject({
  revision: a.string(),
  changed: a.boolean(),
  applied: a.boolean(),
  attempts: a.pipe(a.number(), a.integer(), a.minValue(0)),
})
const accessLogRecordSchema = a.record(a.string(), a.unknown())
const accessLogPageSchema = a.object({
  records: a.array(accessLogRecordSchema),
  next: a.optional(a.string()),
  partial: a.boolean(),
  malformedLines: a.pipe(a.number(), a.integer(), a.minValue(0)),
})
const projectAclRepairSchema = a.object({
  roots: a.array(
    a.object({
      root: a.string(),
      entries: a.pipe(a.number(), a.integer(), a.minValue(0)),
      skipped: a.optional(a.literal("caddy-root")),
    }),
  ),
})
const routeCheckTlsSchema = a.object({
  authorized: a.boolean(),
  validTo: a.nullable(a.string()),
  issuer: a.nullable(a.string()),
})
const routeCheckRowSchema = a.object({
  service: a.string(),
  hostname: a.string(),
  addresses: a.array(a.string()),
  tls: a.nullable(routeCheckTlsSchema),
  httpStatus: a.nullable(a.number()),
  httpMs: a.nullable(a.number()),
  ok: a.boolean(),
  error: a.nullable(a.string()),
})
const routeCheckSchema = a.object({
  project: a.string(),
  service: a.optional(a.string()),
  rows: a.array(routeCheckRowSchema),
})

function routeCheckRowLine(row: a.InferOutput<typeof routeCheckRowSchema>): string {
  if (!row.ok) return `FAIL\t${row.service}\t${row.hostname}\t${row.error ?? "unreachable"}`
  const tls = row.tls?.issuer ?? "trusted"
  return `ok\t${row.service}\t${row.hostname}\t${row.addresses.join(",")}\thttp ${row.httpStatus ?? "-"}\ttls ${tls}\t${row.httpMs ?? "-"}ms`
}
const backendVersionSchema = a.object({ version: a.string() })
const splitDnsRollbackSchema = a.object({ stateFile: a.string(), restored: a.array(a.string()) })

function dataParse<TSchema extends a.BaseSchema<unknown, unknown, a.BaseIssue<unknown>>>(
  schema: TSchema,
  data: unknown,
  label: string,
): Result<a.InferOutput<TSchema>> {
  const op = "projectRegistryCliOutputFormat"
  const parsed = a.safeParse(schema, data)
  if (!parsed.success) return createResultError(op, `project-registryd returned malformed ${label} data.`)
  return createResult(parsed.output)
}

function cloudflareDnsStatusLines(dns: ProjectRegistryDaemonCloudflareDnsStatus | undefined): string[] {
  if (dns === undefined) return ["Cloudflare DNS: unavailable (older/degraded daemon; not healthy)"]
  if (!dns.enabled) return ["Cloudflare DNS: disabled"]
  const queued = dns.pendingProjects + dns.pendingDeletions
  const health = dns.trackingBlocked || dns.errors.length > 0 ? "error" : queued > 0 ? "pending" : "healthy"
  const lines = [
    `Cloudflare DNS: ${health} (pending projects: ${dns.pendingProjects}, pending deletions: ${dns.pendingDeletions})`,
  ]
  if (dns.trackingBlocked) lines.push("Tracking: blocked (state unavailable)")
  for (const error of dns.errors.slice(0, 5)) lines.push(cloudflareDnsErrorLine(error))
  if (dns.errors.length > 5) lines.push(`... and ${dns.errors.length - 5} more DNS errors`)
  return lines
}

function privateDnsStatusLines(dns: ProjectRegistryDaemonPrivateDnsStatus | undefined): string[] {
  if (dns === undefined) return ["Private DNS: unavailable (older/degraded daemon; not healthy)"]
  if (!dns.enabled) return ["Private DNS: disabled"]
  const queued = dns.pendingProjects + dns.pendingDeletions
  const health = dns.trackingBlocked || dns.errors.length > 0 ? "error" : queued > 0 ? "pending" : "healthy"
  const lines = [
    `Private DNS: ${health} (pending projects: ${dns.pendingProjects}, pending deletions: ${dns.pendingDeletions})`,
  ]
  if (dns.trackingBlocked) lines.push("Tracking: blocked (state unavailable)")
  for (const error of dns.errors.slice(0, 5)) lines.push(cloudflareDnsErrorLine(error))
  if (dns.errors.length > 5) lines.push(`... and ${dns.errors.length - 5} more DNS errors`)
  return lines
}

function privateTlsStatusLines(tls: ProjectRegistryDaemonPrivateTlsStatus | undefined): string[] {
  if (tls === undefined) return ["Private TLS: unavailable (older/degraded daemon; not healthy)"]
  if (!tls.enabled) return ["Private TLS: disabled"]
  const health = tls.errors.length > 0 ? "error" : tls.pendingOwners > 0 ? "pending" : "healthy"
  const lines = [
    `Private TLS: ${health} (pending owners: ${tls.pendingOwners}, enrolled: ${tls.enrolled.length}, wildcard-covered: ${tls.wildcardCovered.length})`,
  ]
  for (const error of tls.errors.slice(0, 5)) {
    const scope = [error.owner, error.hostname].filter((part) => part !== undefined).join(" ")
    lines.push(`TLS error${scope === "" ? "" : ` [${scope}]`}: ${error.operation}: ${error.errorMessage}`)
  }
  if (tls.errors.length > 5) lines.push(`... and ${tls.errors.length - 5} more TLS errors`)
  return lines
}

function cloudflareDnsErrorLine(error: ProjectRegistryDaemonCloudflareDnsStatus["errors"][number]): string {
  const identity = [error.owner, error.project].filter((part) => part !== undefined).join("/")
  const location = error.hostname ?? (error.recordId === undefined ? undefined : `record ${error.recordId}`)
  const subject = [identity === "" ? undefined : identity, location].filter((part) => part !== undefined).join(" ")
  const status = error.statusCode === undefined ? "" : ` status=${error.statusCode}`
  const code = error.cloudflareCode === undefined ? "" : ` cf=${error.cloudflareCode}`
  const retry = error.nextRetryAt === undefined ? "" : ` retry=${new Date(error.nextRetryAt).toISOString()}`
  return `DNS error [${error.operation}]${subject === "" ? "" : ` ${subject}`}: ${error.errorMessage} (attempts: ${error.attempts}${status}${code}${retry})`
}

function projectServiceCell(project: a.InferOutput<typeof projectSchema>): string {
  return project.service === undefined ? "" : `\t${project.service}`
}

function projectLineFormat(project: a.InferOutput<typeof projectSchema>): string {
  return `${project.name}${projectServiceCell(project)}\t${project.kind}\t${project.port ?? "-"}\t${project.domains.join(",")}`
}

function jsonSerialize(data: unknown, indentation = 0): Result<string> {
  const op = "projectRegistryCliOutputFormat"
  try {
    return createResult(`${JSON.stringify(data, null, indentation)}\n`)
  } catch {
    return createResultError(op, "The command output could not be serialized.")
  }
}

export function projectRegistryCliOutputFormat(
  invocation: ProjectRegistryCliInvocation,
  data: unknown,
  owner?: string,
): Result<string> {
  const command = invocation.command
  let parsedData: unknown = data

  if (command.kind === "project-list") {
    const parsedR = dataParse(a.array(projectSchema), data, "project list")
    if (!parsedR.success) return parsedR
    const filteredR = projectFilter(parsedR.data, {
      section: command.section,
      metadata: command.metadata,
    })
    if (!filteredR.success) return filteredR
    parsedData = filteredR.data.map(projectOutputNormalize)
  }
  if (command.kind === "project-get") {
    const parsedR = dataParse(a.union([projectSchema, a.array(projectSchema)]), data, "project")
    if (!parsedR.success) return parsedR
    parsedData = Array.isArray(parsedR.data)
      ? parsedR.data.map(projectOutputNormalize)
      : projectOutputNormalize(parsedR.data)
  }
  if (command.kind === "project-history" || command.kind === "history") {
    const parsedR = dataParse(a.array(historyEntrySchema), data, "history")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "status") {
    const parsedR = dataParse(statusSchema, data, "status")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "project-create" || command.kind === "project-edit" || command.kind === "project-delete") {
    const parsedR = dataParse(mutationSchema, data, "project mutation")
    if (!parsedR.success) return parsedR
    if (parsedR.data.action !== command.kind.slice("project-".length)) {
      return createResultError("projectRegistryCliOutputFormat", "project-registryd returned mismatched mutation data.")
    }
    parsedData = parsedR.data
  }
  if (command.kind === "user-default-domain-get") {
    const parsedR = dataParse(userDefaultDomainSchema, data, "user default-domain")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "user-default-domain-set" || command.kind === "user-default-domain-unset") {
    const parsedR = dataParse(userDefaultDomainMutationSchema, data, "user default-domain mutation")
    if (!parsedR.success) return parsedR
    const expectedAction = command.kind === "user-default-domain-set" ? "set" : "unset"
    if (parsedR.data.action !== expectedAction) {
      return createResultError("projectRegistryCliOutputFormat", "project-registryd returned mismatched mutation data.")
    }
    parsedData = parsedR.data
  }
  if (command.kind === "user-cloudflare-token-set") {
    const parsedR = dataParse(cloudflareTokenMutationSchema, data, "Cloudflare token update")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "project-delete-by-port") {
    const parsedR = dataParse(legacyDeleteSchema, data, "project deletion")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "docs" || command.kind === "docs-local") {
    const parsedR = dataParse(a.union([docsPublicationSchema, docsSchema]), data, "documentation URL")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "regenerate") {
    const parsedR = dataParse(regenerateSchema, data, "regeneration")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "project-access-logs") {
    const parsedR = dataParse(accessLogPageSchema, data, "access-log page")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "project-fix-acl") {
    const parsedR = dataParse(projectAclRepairSchema, data, "project ACL repair")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "route-check") {
    const parsedR = dataParse(routeCheckSchema, data, "route check")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "backend-version") {
    const parsedR = dataParse(backendVersionSchema, data, "version")
    if (!parsedR.success) return parsedR
    parsedData = {
      backend: parsedR.data.version,
      cli: projectRegistryVersion,
      library: projectRegistryVersion,
    }
  }
  if (command.kind === "tailscale-split-dns-rollback") {
    const parsed = a.safeParse(splitDnsRollbackSchema, data)
    if (!parsed.success) {
      return createResultError("projectRegistryCliOutputFormat", "The split-DNS rollback result is malformed.")
    }
    parsedData = parsed.output
  }

  if (invocation.json) return jsonSerialize({ success: true, data: parsedData })
  if (command.kind === "project-list") {
    const projects = parsedData as a.InferOutput<typeof projectSchema>[]
    if (projects.length === 0) return createResult("No projects.\n")
    return createResult(`${projects.map(projectLineFormat).join("\n")}\n`)
  }
  if (command.kind === "project-get") {
    const projects = parsedData as a.InferOutput<typeof projectSchema> | a.InferOutput<typeof projectSchema>[]
    const rows = Array.isArray(projects) ? projects : [projects]
    return createResult(
      `${rows.map((project) => `${project.name}\t${project.user}${projectServiceCell(project)}\t${project.kind}\t${project.port ?? "-"}\t${project.domains.join(",")}`).join("\n")}\n`,
    )
  }
  if (command.kind === "project-history" || command.kind === "history") {
    const history = parsedData as a.InferOutput<typeof historyEntrySchema>[]
    if (history.length === 0) return createResult("No history.\n")
    return createResult(
      `${history.map((entry) => `${entry.sha.slice(0, 8)}\t${entry.date}\t${entry.author}\t${entry.message}`).join("\n")}\n`,
    )
  }
  if (command.kind === "config") {
    try {
      return createResult(`${JSON.stringify(parsedData, null, 2)}\n`)
    } catch {
      return createResultError("projectRegistryCliOutputFormat", "The Caddy configuration could not be serialized.")
    }
  }
  if (command.kind === "status") {
    const status = parsedData as a.InferOutput<typeof statusSchema>
    const lines = [`Caddy: ${status.pending ? "pending" : "applied"}`]
    if (status.desiredRevision !== undefined) lines.push(`Desired: ${status.desiredRevision}`)
    if (status.appliedRevision !== undefined) lines.push(`Applied: ${status.appliedRevision}`)
    if (status.pendingRevision !== undefined) lines.push(`Pending: ${status.pendingRevision}`)
    if (status.error !== undefined) lines.push(`Error: ${status.error}`)
    lines.push(...cloudflareDnsStatusLines(status.cloudflareDns))
    lines.push(...privateDnsStatusLines(status.privateDns))
    lines.push(...privateTlsStatusLines(status.privateTls))
    return createResult(`${lines.join("\n")}\n`)
  }
  if (command.kind === "project-create" || command.kind === "project-edit" || command.kind === "project-delete") {
    const mutation = parsedData as a.InferOutput<typeof mutationSchema>
    const verb = mutation.action === "create" ? "created" : mutation.action === "delete" ? "deleted" : "updated"
    if (!mutation.changed) return createResult(`unchanged ${mutation.key.owner}/${mutation.key.name}\n`)
    return createResult(
      `${verb} ${mutation.key.owner}/${mutation.key.name}\nRegistry saved; DNS changes, when enabled, run asynchronously. Use project-registry status to check DNS.\n`,
    )
  }
  if (command.kind === "user-default-domain-get") {
    const defaultDomain = parsedData as a.InferOutput<typeof userDefaultDomainSchema>
    return createResult(`${defaultDomain.owner}\t${defaultDomain.domain ?? "-"}\t${defaultDomain.source}\n`)
  }
  if (command.kind === "user-default-domain-set" || command.kind === "user-default-domain-unset") {
    const mutation = parsedData as a.InferOutput<typeof userDefaultDomainMutationSchema>
    if (!mutation.changed) return createResult(`unchanged ${mutation.owner}/default-domain\n`)
    return createResult(`${mutation.action} ${mutation.owner}/default-domain\n`)
  }
  if (command.kind === "user-cloudflare-token-set") return createResult("updated cloudflare-token\n")
  if (command.kind === "project-delete-by-port") {
    const deleted = parsedData as a.InferOutput<typeof legacyDeleteSchema>
    return createResult(`deleted ${owner === undefined ? deleted.deleted : `${owner}/${deleted.deleted}`}\n`)
  }
  if (command.kind === "docs" || command.kind === "docs-local") {
    if (typeof parsedData === "object" && parsedData !== null && "indexUrls" in parsedData) {
      const publication = parsedData as a.InferOutput<typeof docsPublicationSchema>
      const urls = [...publication.urls, ...publication.indexUrls]
      return createResult(urls.length === 0 ? "No documentation URLs.\n" : `${urls.join("\n")}\n`)
    }
    const docs = parsedData as a.InferOutput<typeof docsSchema>
    return createResult(docs.urls.length === 0 ? "No documentation URLs.\n" : `${docs.urls.join("\n")}\n`)
  }
  if (command.kind === "regenerate") return createResult("regenerated\n")
  if (command.kind === "project-access-logs") {
    const page = parsedData as a.InferOutput<typeof accessLogPageSchema>
    const recordLines: string[] = []
    for (const record of page.records) {
      const recordR = jsonSerialize(record, 2)
      if (!recordR.success) return recordR
      recordLines.push(recordR.data.slice(0, -1))
    }
    const lines = [...recordLines]
    if (lines.length === 0) lines.push("No access logs.")
    if (page.next !== undefined) lines.push(`Next: ${page.next}`)
    if (page.partial) lines.push("Partial: yes")
    if (page.malformedLines > 0) lines.push(`Malformed lines: ${page.malformedLines}`)
    return createResult(`${lines.join("\n")}\n`)
  }
  if (command.kind === "project-fix-acl") {
    const repair = parsedData as a.InferOutput<typeof projectAclRepairSchema>
    return createResult(
      `${repair.roots
        .map(({ root, entries, skipped }) =>
          skipped === "caddy-root"
            ? `ACL repair unnecessary: Caddy runs as root (${root})`
            : `repaired ${root} (${entries} entries)`,
        )
        .join("\n")}\n`,
    )
  }
  if (command.kind === "backend-version") {
    const versions = parsedData as { backend: string; cli: string; library: string }
    return createResult(`Backend: ${versions.backend}\nCLI: ${versions.cli}\nLibrary: ${versions.library}\n`)
  }
  if (command.kind === "route-check") {
    const checked = parsedData as a.InferOutput<typeof routeCheckSchema>
    if (checked.rows.length === 0) return createResult("No served domains.\n")
    return createResult(`${checked.rows.map(routeCheckRowLine).join("\n")}\n`)
  }
  if (command.kind === "tailscale-split-dns-rollback") {
    const rollback = parsedData as a.InferOutput<typeof splitDnsRollbackSchema>
    if (rollback.restored.length === 0) return createResult("No split-DNS entries to restore.\n")
    return createResult(`restored ${rollback.restored.join(", ")} from ${rollback.stateFile}\n`)
  }
  return createResultError("projectRegistryCliOutputFormat", "The command does not produce daemon output.")
}
