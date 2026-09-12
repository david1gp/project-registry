import { basename, resolve } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type Result, type ResultErr } from "#result"
import type { Project } from "../project/Project.js"
import { type ProjectCanonical, projectCanonicalSchema } from "../project/projectCanonicalSchema.js"
import { projectLabelsSchema } from "../project/projectLabelsSchema.js"
import { projectLocalCaddyEntries } from "../project/projectLocalCaddyEntries.js"
import { projectMigrate } from "../project/projectMigrate.js"
import { projectSchema } from "../project/projectSchema.js"
import { projectRegistryVersionMetadataRender } from "../projectRegistryVersionMetadataRender.js"
import type { ProjectRegistryCliCaddyOptions } from "./ProjectRegistryCliCaddyOptions.js"
import type { ProjectRegistryCliFetch } from "./ProjectRegistryCliFetch.js"
import type { ProjectRegistryCliInvocation } from "./ProjectRegistryCliInvocation.js"
import { projectCliServiceRows } from "./projectCliServiceRows.js"
import { projectNameFromPath } from "./projectNameFromPath.js"
import { projectRegistryCliArgumentsParse } from "./projectRegistryCliArgumentsParse.js"
import { projectRegistryCliHelp } from "./projectRegistryCliHelp.js"
import { projectRegistryCliOutputFormat } from "./projectRegistryCliOutputFormat.js"
import { projectRegistryCliRequest } from "./projectRegistryCliRequest.js"
import { projectRegistryCliSocketResolve } from "./projectRegistryCliSocketResolve.js"
import { projectRegistryCliVersion } from "./projectRegistryCliVersion.js"
import { projectServicesPatchApply } from "./projectServicesPatchApply.js"

type CliRunOptions = {
  environment?: Readonly<Record<string, string | undefined>>
  requestFetch?: ProjectRegistryCliFetch
  stdin?: ReadableStream<Uint8Array>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
}

type CliError = ResultErr & { hint?: string }

type CloudflareTokenReader = {
  read: () => Promise<
    | {
        done: false
        value: Uint8Array
      }
    | {
        done: true
        value?: Uint8Array
      }
  >
  cancel: () => Promise<unknown>
  releaseLock: () => void
}

const maximumCloudflareTokenInputBytes = 16_384
const maximumCloudflareTokenLength = 8_192
const cloudflareTokenInputError = "Cloudflare token input must be one non-empty line."

function requestPath(invocation: ProjectRegistryCliInvocation): string {
  const command = invocation.command
  if (command.kind === "project-list") return "/projects"
  if (command.kind === "project-get") return `/projects/${encodeURIComponent(command.name)}`
  if (command.kind === "project-history") {
    const query = new URLSearchParams({ name: command.name })
    if (command.limit !== undefined) query.set("limit", String(command.limit))
    return `/history?${query}`
  }
  if (command.kind === "history") return command.limit === undefined ? "/history" : `/history?limit=${command.limit}`
  if (command.kind === "config") {
    if (command.selector === undefined) return "/config"
    return `/config?${new URLSearchParams({ select: command.selector })}`
  }
  if (command.kind === "backend-version") return "/api/v1/version"
  return "/api/v1/caddy/status"
}

function accessLogRequestPath(
  command: Extract<ProjectRegistryCliInvocation["command"], { kind: "project-access-logs" }>,
  owner?: string,
): string {
  const query = new URLSearchParams()
  if (command.limit !== undefined) query.set("limit", String(command.limit))
  if (command.before !== undefined) query.set("before", command.before)
  const suffix = query.toString() === "" ? "" : `?${query}`
  const path =
    owner === undefined
      ? `/api/v1/projects/${encodeURIComponent(command.name)}/access-logs`
      : `/api/v1/users/${encodeURIComponent(owner)}/projects/${encodeURIComponent(command.name)}/access-logs`
  return `${path}${suffix}`
}

function ownerResolve(environment: Readonly<Record<string, string | undefined>>): Result<string> {
  const op = "projectRegistryCliOwnerResolve"
  const owner = environment.USER?.trim()
  if (owner === undefined || !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(owner)) {
    return createResultError(op, "The current Unix user is unavailable.")
  }
  return createResult(owner)
}

async function cloudflareTokenRead(stdin: ReadableStream<Uint8Array> | undefined): Promise<Result<string>> {
  const op = "projectRegistryCliCloudflareTokenRead"
  if (stdin === undefined) return createResultError(op, cloudflareTokenInputError)

  let reader: CloudflareTokenReader
  try {
    reader = stdin.getReader()
  } catch {
    return createResultError(op, cloudflareTokenInputError)
  }
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunkR = await reader.read()
      if (chunkR.done) break
      totalBytes += chunkR.value.byteLength
      if (totalBytes > maximumCloudflareTokenInputBytes) {
        await reader.cancel()
        return createResultError(op, cloudflareTokenInputError)
      }
      chunks.push(chunkR.value)
    }
  } catch {
    return createResultError(op, cloudflareTokenInputError)
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let token: string
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return createResultError(op, cloudflareTokenInputError)
  }
  if (token.endsWith("\r\n")) token = token.slice(0, -2)
  else if (token.endsWith("\n")) token = token.slice(0, -1)
  if (
    token.length === 0 ||
    token.trim() === "" ||
    token.length > maximumCloudflareTokenLength ||
    token.includes("\n") ||
    token.includes("\r")
  ) {
    return createResultError(op, cloudflareTokenInputError)
  }
  return createResult(token)
}

function revisionParse(data: unknown): Result<string> {
  const op = "projectRegistryCliRevisionParse"
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return createResultError(op, "project-registryd returned malformed project revision data.")
  }
  const revision = (data as Record<string, unknown>).revision
  if (typeof revision !== "string") {
    return createResultError(op, "project-registryd returned malformed project revision data.")
  }
  return createResult(revision)
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function currentProjectLabelsParse(data: unknown): Result<Record<string, string>> {
  const op = "projectRegistryCliCurrentProjectLabelsParse"
  const response = recordValue(data)
  const project = recordValue(response?.project)
  if (project === undefined) return createResultError(op, "project-registryd returned malformed current project data.")
  const labels = Object.hasOwn(project, "labels") ? project.labels : {}
  const parsed = a.safeParse(projectLabelsSchema, labels)
  if (!parsed.success) return createResultError(op, "project-registryd returned malformed current project labels.")
  return createResult(parsed.output)
}

function projectLabelSet(labels: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(labels, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

const projectAnySchema = a.union([projectCanonicalSchema, projectSchema])
const projectListResponseSchema = a.object({ projects: a.array(projectAnySchema) })
const projectListResponseAnySchema = a.union([projectListResponseSchema, a.array(projectAnySchema)])
const projectResponseSchema = a.object({ project: projectAnySchema, revision: a.string() })

function projectListResponseParse(data: unknown): Result<readonly Project[]> {
  const op = "projectRegistryCliProjectListResponseParse"
  const parsed = a.safeParse(projectListResponseAnySchema, data)
  if (!parsed.success) return createResultError(op, "project-registryd returned malformed project list data.")
  const projects = Array.isArray(parsed.output) ? parsed.output : parsed.output.projects
  return createResult(projects as unknown as readonly Project[])
}

function projectCanonicalParse(project: unknown, op: string): Result<ProjectCanonical> {
  const migrated = projectMigrate(project)
  if (!migrated.success) return createResultError(op, "project-registryd returned malformed project data.")
  return migrated
}

function projectCreateDefaults(command: Extract<ProjectRegistryCliInvocation["command"], { kind: "project-create" }>): {
  name: string
  caddy: ProjectRegistryCliCaddyOptions
} {
  const path = command.caddy.path ?? resolve(process.cwd())
  return {
    name: command.name ?? basename(path),
    caddy: { docs: true, ...command.caddy, ...(command.caddy.path === undefined ? { path } : {}) },
  }
}

function projectCreateDefaultsCollision(
  projects: readonly Project[],
  name: string,
  path: string,
  command: Extract<ProjectRegistryCliInvocation["command"], { kind: "project-create" }>,
): boolean {
  if (command.name !== undefined && command.caddy.path !== undefined) return false
  return projects.some((project) => {
    if (command.name === undefined && project.name === name) return true
    if (command.caddy.path !== undefined) return false
    return projectLocalCaddyEntries(project).some(
      (entry) => entry.caddy.path !== undefined && entry.caddy.path !== "" && resolve(entry.caddy.path) === path,
    )
  })
}

async function jsonProjectReadRequest(
  command: Extract<ProjectRegistryCliInvocation["command"], { kind: "project-list" | "project-get" }>,
  socketPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  requestFetch?: ProjectRegistryCliFetch,
): Promise<Result<unknown>> {
  const ownerR = ownerResolve(environment)
  if (!ownerR.success) return ownerR
  const ownerPath = encodeURIComponent(ownerR.data)
  const path =
    command.kind === "project-list"
      ? `/api/v1/users/${ownerPath}/projects`
      : `/api/v1/users/${ownerPath}/projects/${encodeURIComponent(command.name)}`
  const responseR = await projectRegistryCliRequest(socketPath, path, {}, requestFetch)
  if (!responseR.success) return responseR

  if (command.kind === "project-list") {
    if (Array.isArray(responseR.data)) return responseR
    const op = "projectRegistryCliProjectListResponseParse"
    const parsedR = a.safeParse(projectListResponseSchema, responseR.data)
    if (!parsedR.success) return createResultError(op, "project-registryd returned malformed project list data.")
    const rows: Record<string, unknown>[] = []
    for (const project of parsedR.output.projects) {
      const canonicalR = projectCanonicalParse(project, op)
      if (!canonicalR.success) return canonicalR
      rows.push(...projectCliServiceRows(canonicalR.data))
    }
    return createResult(rows)
  }
  const legacyProject = recordValue(responseR.data)
  if (legacyProject !== undefined && typeof legacyProject.name === "string" && typeof legacyProject.user === "string") {
    return responseR
  }
  const op = "projectRegistryCliProjectResponseParse"
  const parsedR = a.safeParse(projectResponseSchema, responseR.data)
  if (!parsedR.success) return createResultError(op, "project-registryd returned malformed project data.")
  const canonicalR = projectCanonicalParse(parsedR.output.project, op)
  if (!canonicalR.success) return canonicalR
  const rows = projectCliServiceRows(canonicalR.data)
  return createResult(rows.length === 1 ? rows[0]! : rows)
}

async function commandRequest(
  invocation: ProjectRegistryCliInvocation,
  socketPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  requestFetch?: ProjectRegistryCliFetch,
  stdin?: ReadableStream<Uint8Array>,
): Promise<Result<unknown> & { hint?: string }> {
  const command = invocation.command
  if (invocation.json && (command.kind === "project-list" || command.kind === "project-get")) {
    return jsonProjectReadRequest(command, socketPath, environment, requestFetch)
  }
  if (
    command.kind !== "project-create" &&
    command.kind !== "project-edit" &&
    command.kind !== "project-delete" &&
    command.kind !== "project-delete-by-port" &&
    command.kind !== "docs" &&
    command.kind !== "docs-local" &&
    command.kind !== "regenerate" &&
    command.kind !== "project-access-logs" &&
    command.kind !== "user-default-domain-get" &&
    command.kind !== "user-default-domain-set" &&
    command.kind !== "user-default-domain-unset" &&
    command.kind !== "user-cloudflare-token-set"
  ) {
    return projectRegistryCliRequest(socketPath, requestPath(invocation), {}, requestFetch)
  }
  if (command.kind === "regenerate") {
    return projectRegistryCliRequest(socketPath, "/api/v1/caddy/regenerate", { method: "POST" }, requestFetch)
  }

  if (command.kind === "project-access-logs") {
    return projectRegistryCliRequest(socketPath, accessLogRequestPath(command, command.owner), {}, requestFetch)
  }

  const ownerR = ownerResolve(environment)
  if (!ownerR.success) return ownerR
  const ownerPath = encodeURIComponent(ownerR.data)

  if (
    command.kind === "user-default-domain-get" ||
    command.kind === "user-default-domain-set" ||
    command.kind === "user-default-domain-unset"
  ) {
    const path = `/api/v1/users/${ownerPath}/default-domain`
    if (command.kind === "user-default-domain-get") return projectRegistryCliRequest(socketPath, path, {}, requestFetch)
    const currentR = await projectRegistryCliRequest(socketPath, path, {}, requestFetch)
    if (!currentR.success) return currentR
    const revisionR = revisionParse(currentR.data)
    if (!revisionR.success) return revisionR
    if (command.kind === "user-default-domain-set") {
      return projectRegistryCliRequest(
        socketPath,
        path,
        { method: "PUT", body: { expectedRevision: revisionR.data, domain: command.domain } },
        requestFetch,
      )
    }
    return projectRegistryCliRequest(
      socketPath,
      path,
      { method: "DELETE", body: { expectedRevision: revisionR.data } },
      requestFetch,
    )
  }

  if (command.kind === "user-cloudflare-token-set") {
    const tokenR = await cloudflareTokenRead(stdin)
    if (!tokenR.success) return tokenR
    return projectRegistryCliRequest(
      socketPath,
      `/api/v1/users/${ownerPath}/cloudflare-token`,
      { method: "PUT", body: { token: tokenR.data } },
      requestFetch,
    )
  }

  if (command.kind === "docs" || command.kind === "docs-local") {
    let name: string
    if (command.kind === "docs") {
      name = command.name
    } else {
      const projectsR = await projectRegistryCliRequest(
        socketPath,
        `/api/v1/users/${ownerPath}/projects`,
        {},
        requestFetch,
      )
      if (!projectsR.success) return projectsR
      const projectListR = projectListResponseParse(projectsR.data)
      if (!projectListR.success) return projectListR
      const nameR = projectNameFromPath(projectListR.data, process.cwd())
      if (!nameR.success) return nameR
      name = nameR.data
    }
    const query = new URLSearchParams({ path: command.path })
    if (command.http) query.set("scheme", "http")
    const path = `/api/v1/users/${ownerPath}/projects/${encodeURIComponent(name)}/docs?${query}`
    return projectRegistryCliRequest(socketPath, path, {}, requestFetch)
  }
  if (command.kind === "project-delete-by-port") {
    return projectRegistryCliRequest(
      socketPath,
      `/projects/by-port/${command.port}`,
      { method: "DELETE" },
      requestFetch,
    )
  }

  const projectPath =
    command.kind === "project-create"
      ? `/api/v1/users/${ownerPath}/projects`
      : `/api/v1/users/${ownerPath}/projects/${encodeURIComponent(command.name)}`
  const currentR = await projectRegistryCliRequest(socketPath, projectPath, {}, requestFetch)
  if (!currentR.success) return currentR
  const revisionR = revisionParse(currentR.data)
  if (!revisionR.success) return revisionR

  let options: RequestOptions
  if (command.kind === "project-create") {
    const defaults = projectCreateDefaults(command)
    const projectsR = projectListResponseParse(currentR.data)
    if (!projectsR.success) return projectsR
    if (
      projectCreateDefaultsCollision(
        projectsR.data,
        defaults.name,
        resolve(defaults.caddy.path ?? process.cwd()),
        command,
      )
    ) {
      return {
        ...createResultError(
          "projectRegistryCliProjectCreate",
          "Project create defaults collide with an existing project; provide explicit --name and --path.",
        ),
        hint: "Use explicit --name and --path values, then retry.",
      }
    }
    options = {
      method: "POST",
      body: {
        expectedRevision: revisionR.data,
        name: defaults.name,
        ...(command.service === undefined
          ? { caddy: defaults.caddy }
          : {
              schemaVersion: 2,
              services: [
                {
                  id: command.service,
                  units: [],
                  caddy: defaults.caddy,
                  ownership: command.ownership ?? "registry",
                },
              ],
            }),
        ...(command.noDns === true ? { noDns: true } : {}),
        ...(command.labels === undefined ? {} : { labels: command.labels }),
      },
    }
  } else if (command.kind === "project-edit") {
    const body: Record<string, unknown> = { expectedRevision: revisionR.data }
    if (command.service !== undefined) {
      const projectResponse = recordValue(currentR.data)
      const canonicalR = projectCanonicalParse(projectResponse?.project, "projectRegistryCliProjectResponseParse")
      if (!canonicalR.success) return canonicalR
      const servicesR = projectServicesPatchApply(
        canonicalR.data.services,
        command.service,
        command.caddy,
        command.ownership,
      )
      if (!servicesR.success) {
        return { ...servicesR, hint: "Run 'project-registry project get <name> --json' to list existing services." }
      }
      body.schemaVersion = 2
      body.services = servicesR.data
    } else if (Object.keys(command.caddy).length > 0) {
      body.caddy = command.caddy
    }
    const hasLabelOptions =
      command.labels !== undefined || command.removeLabels !== undefined || command.clearLabels === true
    if (hasLabelOptions) {
      const labelsR = currentProjectLabelsParse(currentR.data)
      if (!labelsR.success) return labelsR
      let labels = labelsR.data
      if (command.clearLabels === true) labels = {}
      for (const key of command.removeLabels ?? []) delete labels[key]
      for (const [key, value] of Object.entries(command.labels ?? {})) projectLabelSet(labels, key, value)
      body.labels = labels
    }
    options = { method: "PATCH", body }
  } else {
    options = { method: "DELETE", body: { expectedRevision: revisionR.data } }
  }
  return projectRegistryCliRequest(socketPath, projectPath, options, requestFetch)
}

function errorWrite(error: CliError, json: boolean, write: (text: string) => void): void {
  if (!json) {
    write(`error: ${error.errorMessage}\n`)
    if ("hint" in error && typeof error.hint === "string") write(`hint: ${error.hint}\n`)
    return
  }
  const errorData = {
    code: error.code ?? "cli.error",
    message: error.errorMessage,
    op: error.op,
    status: error.statusCode ?? null,
    ...("hint" in error && typeof error.hint === "string" ? { hint: error.hint } : {}),
  }
  write(
    `${JSON.stringify({
      success: false,
      error: errorData,
    })}\n`,
  )
}

export async function projectRegistryCliRun(args: readonly string[], options: CliRunOptions = {}): Promise<number> {
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text))
  const writeError = options.stderr ?? ((text: string) => process.stderr.write(text))
  const invocationR = projectRegistryCliArgumentsParse(args)
  if (!invocationR.success) {
    const hint =
      "hint" in invocationR && typeof invocationR.hint === "string"
        ? invocationR.hint
        : "Run 'project-registry --help' to see valid commands and options."
    errorWrite({ ...invocationR, code: "cli.usage", hint }, args.includes("--json"), writeError)
    return 2
  }

  const invocation = invocationR.data
  if (invocation.command.kind === "help") {
    writeOut(projectRegistryCliHelp)
    return 0
  }
  if (invocation.command.kind === "version") {
    if (invocation.command.verbose === true) {
      writeOut(projectRegistryVersionMetadataRender("project-registry"))
      return 0
    }
    writeOut(`project-registry ${projectRegistryCliVersion}\n`)
    return 0
  }

  const environment = options.environment ?? Bun.env
  const socketR = projectRegistryCliSocketResolve(invocation.socket, environment)
  if (!socketR.success) {
    errorWrite({ ...socketR, code: "cli.socket" }, invocation.json, writeError)
    return 1
  }
  const stdin =
    invocation.command.kind === "user-cloudflare-token-set" ? (options.stdin ?? Bun.stdin.stream()) : undefined
  const responseR = await commandRequest(invocation, socketR.data, environment, options.requestFetch, stdin)
  if (!responseR.success) {
    errorWrite(responseR, invocation.json, writeError)
    return 1
  }
  const outputOwner = invocation.command.kind === "project-delete-by-port" ? environment.USER?.trim() : undefined
  const outputR = projectRegistryCliOutputFormat(invocation, responseR.data, outputOwner)
  if (!outputR.success) {
    errorWrite({ ...outputR, code: "cli.protocol" }, invocation.json, writeError)
    return 1
  }
  writeOut(outputR.data)
  return 0
}
