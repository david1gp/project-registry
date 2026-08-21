import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import type { ProjectRegistryCliInvocation } from "./ProjectRegistryCliInvocation.js"

const projectSchema = a.looseObject({
  name: a.string(),
  user: a.string(),
  port: a.optional(a.number()),
  domains: a.array(a.string()),
  kind: a.picklist(["proxy", "static"]),
})
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
const docsSchema = a.object({ urls: a.array(a.string()) })
const regenerateSchema = a.looseObject({
  revision: a.string(),
  changed: a.boolean(),
  applied: a.boolean(),
  attempts: a.pipe(a.number(), a.integer(), a.minValue(0)),
})
const accessLogRecordSchema = a.object({
  timestamp: a.pipe(a.number(), a.finite(), a.minValue(0), a.maxValue(8_640_000_000_000)),
  method: a.string(),
  host: a.string(),
  path: a.string(),
  status: a.pipe(a.number(), a.integer(), a.minValue(0), a.maxValue(999)),
  duration: a.pipe(a.number(), a.finite(), a.minValue(0)),
  responseBytes: a.pipe(a.number(), a.integer(), a.minValue(0)),
  clientNetwork: a.string(),
})
const accessLogPageSchema = a.object({
  records: a.array(accessLogRecordSchema),
  next: a.optional(a.string()),
  partial: a.boolean(),
  malformedLines: a.pipe(a.number(), a.integer(), a.minValue(0)),
})

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

function jsonSerialize(data: unknown): Result<string> {
  const op = "projectRegistryCliOutputFormat"
  try {
    return createResult(`${JSON.stringify(data)}\n`)
  } catch {
    return createResultError(op, "The command output could not be serialized.")
  }
}

export function projectRegistryCliOutputFormat(
  invocation: ProjectRegistryCliInvocation,
  data: unknown,
): Result<string> {
  const command = invocation.command
  let parsedData: unknown = data

  if (command.kind === "project-list") {
    const parsedR = dataParse(a.array(projectSchema), data, "project list")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
  }
  if (command.kind === "project-get") {
    const parsedR = dataParse(projectSchema, data, "project")
    if (!parsedR.success) return parsedR
    parsedData = parsedR.data
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
  if (command.kind === "docs") {
    const parsedR = dataParse(docsSchema, data, "documentation URL")
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

  if (invocation.json) return jsonSerialize({ success: true, data: parsedData })
  if (command.kind === "project-list") {
    const projects = parsedData as a.InferOutput<typeof projectSchema>[]
    if (projects.length === 0) return createResult("No projects.\n")
    return createResult(
      `${projects
        .map((project) => `${project.name}\t${project.kind}\t${project.port ?? "-"}\t${project.domains.join(",")}`)
        .join("\n")}\n`,
    )
  }
  if (command.kind === "project-get") {
    const project = parsedData as a.InferOutput<typeof projectSchema>
    return createResult(
      `${project.name}\t${project.user}\t${project.kind}\t${project.port ?? "-"}\t${project.domains.join(",")}\n`,
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
    return createResult(`${lines.join("\n")}\n`)
  }
  if (command.kind === "project-create" || command.kind === "project-edit" || command.kind === "project-delete") {
    const mutation = parsedData as a.InferOutput<typeof mutationSchema>
    const verb = mutation.action === "create" ? "created" : mutation.action === "delete" ? "deleted" : "updated"
    if (!mutation.changed) return createResult(`unchanged ${mutation.key.owner}/${mutation.key.name}\n`)
    return createResult(`${verb} ${mutation.key.owner}/${mutation.key.name}\n`)
  }
  if (command.kind === "docs") {
    const docs = parsedData as a.InferOutput<typeof docsSchema>
    return createResult(docs.urls.length === 0 ? "No documentation URLs.\n" : `${docs.urls.join("\n")}\n`)
  }
  if (command.kind === "regenerate") return createResult("regenerated\n")
  if (command.kind === "project-access-logs") {
    const page = parsedData as a.InferOutput<typeof accessLogPageSchema>
    const lines = page.records.map((record) =>
      [
        new Date(record.timestamp * 1_000).toISOString(),
        record.method,
        record.host,
        record.path,
        record.status,
        record.duration,
        record.responseBytes,
        record.clientNetwork,
      ].join("\t"),
    )
    if (lines.length === 0) lines.push("No access logs.")
    if (page.next !== undefined) lines.push(`Next: ${page.next}`)
    if (page.partial) lines.push("Partial: yes")
    if (page.malformedLines > 0) lines.push(`Malformed lines: ${page.malformedLines}`)
    return createResult(`${lines.join("\n")}\n`)
  }
  return createResultError("projectRegistryCliOutputFormat", "The command does not produce daemon output.")
}
