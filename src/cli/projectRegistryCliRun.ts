import { createResult, createResultError, type Result, type ResultErr } from "#result"
import type { ProjectRegistryCliFetch } from "./ProjectRegistryCliFetch.js"
import type { ProjectRegistryCliInvocation } from "./ProjectRegistryCliInvocation.js"
import { projectRegistryCliArgumentsParse } from "./projectRegistryCliArgumentsParse.js"
import { projectRegistryCliHelp } from "./projectRegistryCliHelp.js"
import { projectRegistryCliOutputFormat } from "./projectRegistryCliOutputFormat.js"
import { projectRegistryCliRequest } from "./projectRegistryCliRequest.js"
import { projectRegistryCliSocketResolve } from "./projectRegistryCliSocketResolve.js"
import { projectRegistryCliVersion } from "./projectRegistryCliVersion.js"

type CliRunOptions = {
  environment?: Readonly<Record<string, string | undefined>>
  requestFetch?: ProjectRegistryCliFetch
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
}

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

async function commandRequest(
  invocation: ProjectRegistryCliInvocation,
  socketPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  requestFetch?: ProjectRegistryCliFetch,
): Promise<Result<unknown>> {
  const command = invocation.command
  if (
    command.kind !== "project-create" &&
    command.kind !== "project-edit" &&
    command.kind !== "project-delete" &&
    command.kind !== "docs" &&
    command.kind !== "regenerate" &&
    command.kind !== "project-access-logs"
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

  if (command.kind === "docs") {
    const query = new URLSearchParams({ path: command.path })
    if (command.http) query.set("scheme", "http")
    const path = `/api/v1/users/${ownerPath}/projects/${encodeURIComponent(command.name)}/docs?${query}`
    return projectRegistryCliRequest(socketPath, path, {}, requestFetch)
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
    options = {
      method: "POST",
      body: { expectedRevision: revisionR.data, name: command.name, caddy: command.caddy },
    }
  } else if (command.kind === "project-edit") {
    const body: Record<string, unknown> = { expectedRevision: revisionR.data }
    if (Object.keys(command.caddy).length > 0) body.caddy = command.caddy
    options = { method: "PATCH", body }
  } else {
    options = { method: "DELETE", body: { expectedRevision: revisionR.data } }
  }
  return projectRegistryCliRequest(socketPath, projectPath, options, requestFetch)
}

function errorWrite(error: ResultErr, json: boolean, write: (text: string) => void): void {
  if (!json) {
    write(`error: ${error.errorMessage}\n`)
    return
  }
  write(
    `${JSON.stringify({
      success: false,
      error: {
        code: error.code ?? "cli.error",
        message: error.errorMessage,
        op: error.op,
        status: error.statusCode ?? null,
      },
    })}\n`,
  )
}

export async function projectRegistryCliRun(args: readonly string[], options: CliRunOptions = {}): Promise<number> {
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text))
  const writeError = options.stderr ?? ((text: string) => process.stderr.write(text))
  const invocationR = projectRegistryCliArgumentsParse(args)
  if (!invocationR.success) {
    errorWrite({ ...invocationR, code: "cli.usage" }, args.includes("--json"), writeError)
    if (!args.includes("--json")) writeError("Try 'project-registry --help'.\n")
    return 2
  }

  const invocation = invocationR.data
  if (invocation.command.kind === "help") {
    writeOut(projectRegistryCliHelp)
    return 0
  }
  if (invocation.command.kind === "version") {
    writeOut(`project-registry ${projectRegistryCliVersion}\n`)
    return 0
  }

  const environment = options.environment ?? Bun.env
  const socketR = projectRegistryCliSocketResolve(invocation.socket, environment)
  if (!socketR.success) {
    errorWrite({ ...socketR, code: "cli.socket" }, invocation.json, writeError)
    return 1
  }
  const responseR = await commandRequest(invocation, socketR.data, environment, options.requestFetch)
  if (!responseR.success) {
    errorWrite(responseR, invocation.json, writeError)
    return 1
  }
  const outputR = projectRegistryCliOutputFormat(invocation, responseR.data)
  if (!outputR.success) {
    errorWrite({ ...outputR, code: "cli.protocol" }, invocation.json, writeError)
    return 1
  }
  writeOut(outputR.data)
  return 0
}
