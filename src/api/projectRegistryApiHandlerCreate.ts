import { createResult, createResultError, type Result } from "#result"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { ProjectAccessLogSource } from "../access-log/ProjectAccessLogSource.js"
import { projectAccessLogListUseCase } from "../access-log/projectAccessLogListUseCase.js"
import { projectAccessLogSourceFileCreate } from "../access-log/projectAccessLogSourceFileCreate.js"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { CaddyApplicationResult } from "../caddy/CaddyApplicationResult.js"
import { caddyConfigInspectUseCase } from "../caddy/caddyConfigInspectUseCase.js"
import type { CaddyConfigOptions } from "../caddy/caddyConfigOptionsSchema.js"
import { projectDocsUrlsUseCase } from "../caddy/projectDocsUrlsUseCase.js"
import type { Project } from "../project/Project.js"
import type { ProjectMutationOptions } from "../project/ProjectMutationOptions.js"
import { projectCreate } from "../project/projectCreate.js"
import { projectDelete } from "../project/projectDelete.js"
import { projectEdit } from "../project/projectEdit.js"
import { projectGetUseCase } from "../project/projectGetUseCase.js"
import { projectHistory } from "../project/projectHistory.js"
import { projectListUseCase } from "../project/projectListUseCase.js"
import type { ProjectPortRange } from "../project/projectPortNext.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { ProjectRegistryDaemonRequestContext } from "../runtime/ProjectRegistryDaemonRequestContext.js"
import type { ProjectRegistryDaemonRequestHandler } from "../runtime/ProjectRegistryDaemonRequestHandler.js"
import type { ProjectRegistryDaemonSocketAccessResolve } from "../runtime/ProjectRegistryDaemonSocketAccessResolve.js"

type ApiHandlerOptions = {
  repository: ProjectRepository
  caddyApplication: Pick<CaddyApplication, "projectChange" | "regenerate" | "status">
  configOptions?: CaddyConfigOptions
  portRange?: ProjectPortRange
  projectAccessLogSource?: ProjectAccessLogSource
  socketAccessResolve?: ProjectRegistryDaemonSocketAccessResolve
}

type ApiRoute =
  | { kind: "projects"; legacy: boolean; owner?: string }
  | { kind: "docs"; legacy: boolean; owner?: string; name: string }
  | { kind: "project"; legacy: boolean; owner?: string; name: string }
  | { kind: "access-logs"; legacy: false; owner: string; name: string }
  | { kind: "self-access-logs"; legacy: false; name: string }
  | { kind: "history"; legacy: boolean; owner?: string; name?: string }
  | { kind: "config"; legacy: boolean }
  | { kind: "status"; legacy: false }
  | { kind: "regenerate"; legacy: boolean }

type ResultFailure = {
  success: false
  op: string
  errorMessage: string
}

type ApiFailure = {
  code: string
  message: string
  op: string
  status: number
  retryable: boolean
  details: Record<string, never>
}

type ApiFailureInput = Omit<ApiFailure, "retryable" | "details"> & { retryable?: boolean }

const responseHeaders = { "cache-control": "no-store", "content-type": "application/json" }
const ownerPattern = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/
const projectNamePattern = /^[a-z0-9][a-z0-9-]*$/

function requestAccessCreate(username: string): ProjectAccess {
  return {
    actorResolve: async () => createResult({ subject: null, username, role: "own" }),
    ownerRoleResolve: async () => createResult("own"),
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders })
}

function successResponse(data: unknown): Response {
  return jsonResponse({ success: true, data })
}

function errorResponse(failure: ApiFailureInput, legacy: boolean, headers?: Record<string, string>): Response {
  if (legacy) {
    return new Response(
      JSON.stringify({ success: false, op: failure.op, errorMessage: failure.message, code: failure.code }),
      { status: failure.status, headers: { ...responseHeaders, ...headers } },
    )
  }
  const { retryable = false, ...failureData } = failure
  const error: ApiFailure = { ...failureData, retryable, details: {} }
  return new Response(JSON.stringify({ success: false, error }), {
    status: failure.status,
    headers: { ...responseHeaders, ...headers },
  })
}

function legacyDocsErrorResponse(result: ResultFailure, status: number): Response {
  return jsonResponse({ success: false, op: result.op, errorMessage: result.errorMessage }, status)
}

function segmentDecode(value: string, pattern: RegExp): string | undefined {
  try {
    const decoded = decodeURIComponent(value)
    if (decoded.includes("/") || decoded.includes("\\") || !pattern.test(decoded)) return undefined
    return decoded
  } catch {
    return undefined
  }
}

function routeParse(path: string): ApiRoute | undefined {
  if (path === "/projects") return { kind: "projects", legacy: true }
  if (path === "/config") return { kind: "config", legacy: true }
  if (path === "/history") return { kind: "history", legacy: true }
  if (path === "/api/v1/caddy/config") return { kind: "config", legacy: false }
  if (path === "/api/v1/caddy/status") return { kind: "status", legacy: false }
  if (path === "/api/v1/caddy/regenerate") return { kind: "regenerate", legacy: false }
  if (path === "/regenerate") return { kind: "regenerate", legacy: true }

  const versionedHistory = path.match(/^\/api\/v1\/users\/([^/]+)\/projects\/([^/]+)\/history$/)
  if (versionedHistory !== null) {
    const owner = segmentDecode(versionedHistory[1]!, ownerPattern)
    const name = segmentDecode(versionedHistory[2]!, projectNamePattern)
    if (owner === undefined || name === undefined) return undefined
    return { kind: "history", legacy: false, owner, name }
  }

  const versionedDocs = path.match(/^\/api\/v1\/users\/([^/]+)\/projects\/([^/]+)\/docs$/)
  if (versionedDocs !== null) {
    const owner = segmentDecode(versionedDocs[1]!, ownerPattern)
    const name = segmentDecode(versionedDocs[2]!, projectNamePattern)
    if (owner === undefined || name === undefined) return undefined
    return { kind: "docs", legacy: false, owner, name }
  }

  const versionedProject = path.match(/^\/api\/v1\/users\/([^/]+)\/projects\/([^/]+)$/)
  if (versionedProject !== null) {
    const owner = segmentDecode(versionedProject[1]!, ownerPattern)
    const name = segmentDecode(versionedProject[2]!, projectNamePattern)
    if (owner === undefined || name === undefined) return undefined
    return { kind: "project", legacy: false, owner, name }
  }

  const versionedAccessLogs = path.match(/^\/api\/v1\/users\/([^/]+)\/projects\/([^/]+)\/access-logs$/)
  if (versionedAccessLogs !== null) {
    const owner = segmentDecode(versionedAccessLogs[1]!, ownerPattern)
    const name = segmentDecode(versionedAccessLogs[2]!, projectNamePattern)
    if (owner === undefined || name === undefined) return undefined
    return { kind: "access-logs", legacy: false, owner, name }
  }

  const selfAccessLogs = path.match(/^\/api\/v1\/projects\/([^/]+)\/access-logs$/)
  if (selfAccessLogs !== null) {
    const name = segmentDecode(selfAccessLogs[1]!, projectNamePattern)
    if (name === undefined) return undefined
    return { kind: "self-access-logs", legacy: false, name }
  }

  const versionedProjects = path.match(/^\/api\/v1\/users\/([^/]+)\/projects$/)
  if (versionedProjects !== null) {
    const owner = segmentDecode(versionedProjects[1]!, ownerPattern)
    if (owner === undefined) return undefined
    return { kind: "projects", legacy: false, owner }
  }

  const legacyDocs = path.match(/^\/projects\/([^/]+)\/docs$/)
  if (legacyDocs !== null) {
    const name = segmentDecode(legacyDocs[1]!, projectNamePattern)
    if (name === undefined) return undefined
    return { kind: "docs", legacy: true, name }
  }

  const legacyProject = path.match(/^\/projects\/([^/]+)$/)
  if (legacyProject !== null) {
    const name = segmentDecode(legacyProject[1]!, projectNamePattern)
    if (name === undefined) return undefined
    return { kind: "project", legacy: true, name }
  }
  return undefined
}

async function socketAccessBind(
  username: string,
  resolve: ProjectRegistryDaemonSocketAccessResolve,
): Promise<Result<ProjectAccess>> {
  const op = "projectRegistryApiSocketAccessResolve"
  let accessR: Result<ProjectAccess>
  try {
    accessR = await resolve(username)
  } catch {
    return createResultError(op, "socket actor role is unavailable")
  }
  if (!accessR.success) return accessR

  let actorR: Awaited<ReturnType<ProjectAccess["actorResolve"]>>
  try {
    actorR = await accessR.data.actorResolve()
  } catch {
    return createResultError(op, "socket actor role is unavailable")
  }
  if (!actorR.success) return actorR
  if (actorR.data.username !== username) return createResultError(op, "socket actor mapping is unavailable")
  const actor = actorR.data
  return createResult({
    actorResolve: async () => createResult(actor),
    ownerRoleResolve: (owner) => accessR.data.ownerRoleResolve(owner),
  })
}

function routeRequiresProjectAccess(route: ApiRoute): boolean {
  return (
    route.kind === "projects" ||
    route.kind === "docs" ||
    route.kind === "project" ||
    route.kind === "access-logs" ||
    route.kind === "self-access-logs" ||
    route.kind === "history" ||
    route.kind === "config"
  )
}

function resultErrorResponse(result: ResultFailure, legacy: boolean, feature: "projects" | "caddy"): Response {
  const message = result.errorMessage
  if (/not found|no server block matching/i.test(message)) {
    return errorResponse({ code: `${feature}.not-found`, message, op: result.op, status: 404 }, legacy)
  }
  if (/not authorized|current role is unavailable|requires superadmin/i.test(message)) {
    return errorResponse(
      { code: `${feature}.forbidden`, message: "Access is forbidden.", op: result.op, status: 403 },
      legacy,
    )
  }
  if (/already exists|collision|conflict|revision mismatch|revision changed|worktree is dirty/i.test(message)) {
    return errorResponse({ code: `${feature}.conflict`, message, op: result.op, status: 409 }, legacy)
  }
  if (/invalid|required|positive integer|must be|immutable|expectedRevision|no free port|port range/i.test(message)) {
    return errorResponse({ code: "request.invalid", message, op: result.op, status: 400 }, legacy)
  }
  return errorResponse(
    { code: "platform.internal", message: "The request could not be completed.", op: result.op, status: 500 },
    legacy,
  )
}

function accessLogErrorResponse(result: ResultFailure): Response {
  const code = "code" in result && typeof result.code === "string" ? result.code : undefined
  if (code === "access-log.not-found") {
    return errorResponse(
      {
        code,
        message: "Project access logs are unavailable.",
        op: result.op,
        status: 404,
      },
      false,
    )
  }
  if (code === "access-log.invalid-input" || code === "access-log.invalid-cursor") {
    return errorResponse({ code, message: result.errorMessage, op: result.op, status: 400 }, false)
  }
  if (code === "access-log.cursor-expired") {
    return errorResponse({ code, message: result.errorMessage, op: result.op, status: 410 }, false)
  }
  if (code === "access-log.unavailable" || code === undefined || code.startsWith("access-log.")) {
    return errorResponse(
      {
        code: code ?? "access-log.unavailable",
        message: "Project access logging is unavailable.",
        op: result.op,
        status: 503,
        retryable: true,
      },
      false,
    )
  }
  return errorResponse(
    {
      code: "platform.internal",
      message: "The request could not be completed.",
      op: result.op,
      status: 500,
    },
    false,
  )
}

function routeMethods(route: ApiRoute): readonly string[] {
  if (route.kind === "projects") return route.legacy ? ["GET"] : ["GET", "POST"]
  if (route.kind === "docs") return ["GET"]
  if (route.kind === "project") return route.legacy ? ["GET", "PUT", "PATCH", "DELETE"] : ["GET", "PATCH", "DELETE"]
  if (route.kind === "regenerate") return ["POST"]
  return ["GET"]
}

function accessLogInputParse(url: URL): Result<{ limit?: number; before?: string }> {
  const op = "projectRegistryApiAccessLogsInput"
  const keys = [...url.searchParams.keys()]
  if (keys.some((key) => key !== "limit" && key !== "before")) {
    return { ...createResultError(op, "Access-log query parameters are invalid.") }
  }

  const limits = url.searchParams.getAll("limit")
  if (limits.length > 1 || (limits.length === 1 && !/^[1-9]\d*$/.test(limits[0]!))) {
    return { ...createResultError(op, "Access-log limit must be a positive bounded integer.") }
  }
  if (limits.length === 1) {
    const limit = Number(limits[0])
    if (!Number.isSafeInteger(limit) || limit > 1_000) {
      return { ...createResultError(op, "Access-log limit must be a positive bounded integer.") }
    }
  }

  const cursors = url.searchParams.getAll("before")
  if (cursors.length > 1 || (cursors.length === 1 && (cursors[0] === "" || cursors[0]!.length > 4_096))) {
    return { ...createResultError(op, "Access-log cursor is invalid.") }
  }

  return createResult({
    ...(limits.length === 0 ? {} : { limit: Number(limits[0]) }),
    ...(cursors.length === 0 ? {} : { before: cursors[0] }),
  })
}

async function requestBodyJson(request: Request, legacy: boolean): Promise<unknown | Response> {
  try {
    return await request.json()
  } catch {
    return errorResponse(
      {
        code: "request.invalid",
        message: "The request body must be valid JSON.",
        op: "projectRegistryApiBodyParse",
        status: 400,
      },
      legacy,
    )
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function expectedRevision(input: unknown): ProjectMutationOptions {
  return { expectedRevision: recordValue(input)?.expectedRevision as string }
}

const legacyCaddyKeys = [
  "port",
  "domains",
  "path",
  "access",
  "kind",
  "docs",
  "browse",
  "headerUp",
  "disabled",
  "routed",
  "oidcPaths",
  "docsPath",
  "browseTemplate",
  "staticAllow",
  "denyDotfiles",
  "spa",
  "flushInterval",
] as const

function legacyCaddyPatch(input: unknown): Record<string, unknown> | undefined {
  const record = recordValue(input)
  if (record === undefined) return undefined
  const caddy: Record<string, unknown> = Object.create(null)
  for (const key of legacyCaddyKeys) {
    if (Object.hasOwn(record, key)) caddy[key] = record[key]
  }
  return caddy
}

function legacyPutPatch(input: unknown): Record<string, unknown> | undefined {
  const record = recordValue(input)
  if (record === undefined || !Object.hasOwn(record, "port") || !Object.hasOwn(record, "domains")) return undefined
  const provided = legacyCaddyPatch(record)
  if (provided === undefined) return undefined
  return {
    caddy: {
      path: "",
      access: "external",
      kind: "proxy",
      docs: true,
      browse: false,
      headerUp: {},
      disabled: false,
      denyDotfiles: false,
      spa: false,
      ...provided,
    },
  }
}

async function currentRevision(repository: ProjectRepository): Promise<ProjectMutationOptions | ResultFailure> {
  const snapshotR = await repository.read()
  if (!snapshotR.success) return snapshotR
  return { expectedRevision: snapshotR.data.revision }
}

async function caddyProjectChange(
  application: Pick<CaddyApplication, "projectChange">,
  mutation: ProjectRepositoryMutation,
): Promise<{ success: true; data: CaddyApplicationResult } | ResultFailure | undefined> {
  if (!mutation.changed) return undefined
  return application.projectChange()
}

function historyLimitParse(url: URL): number | undefined | null {
  const values = url.searchParams.getAll("limit")
  if (values.length === 0) return undefined
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0]!)) return null
  const limit = Number(values[0])
  return Number.isSafeInteger(limit) ? limit : null
}

function legacyProjectMap(project: Project): Record<string, unknown> {
  const caddy = project.caddy
  return {
    name: project.name,
    user: project.owner,
    port: caddy?.port,
    domains: caddy?.domains ?? [],
    path: caddy?.path ?? "",
    access: caddy?.access ?? "external",
    kind: caddy?.kind ?? "proxy",
    docs: caddy?.docs ?? false,
    browse: caddy?.browse ?? false,
    headerUp: caddy?.headerUp ?? {},
    shared: false,
    template: false,
    disabled: caddy?.disabled ?? true,
    routed: caddy?.routed,
    oidcPaths: caddy?.oidcPaths,
    docsPath: caddy?.docsPath,
    browseTemplate: caddy?.browseTemplate,
    staticAllow: caddy?.staticAllow,
    denyDotfiles: caddy?.denyDotfiles,
    spa: caddy?.spa,
    flushInterval: caddy?.flushInterval,
  }
}

function legacySummaryMap(entry: Record<string, unknown>): Record<string, unknown> {
  const { owner, ...summary } = entry
  return { ...summary, user: owner }
}

export function projectRegistryApiHandlerCreate(options: ApiHandlerOptions): ProjectRegistryDaemonRequestHandler {
  const configuredAccessLogSourceR =
    options.projectAccessLogSource === undefined && options.configOptions?.caddyAccessLogRoot !== undefined
      ? projectAccessLogSourceFileCreate({ root: options.configOptions.caddyAccessLogRoot, maxRecords: 1_000 })
      : undefined
  const projectAccessLogSource =
    options.projectAccessLogSource ??
    (configuredAccessLogSourceR?.success === true ? configuredAccessLogSourceR.data : undefined)

  const handle = async (request: Request, context: ProjectRegistryDaemonRequestContext): Promise<Response> => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return errorResponse(
        {
          code: "request.invalid",
          message: "The request URL is invalid.",
          op: "projectRegistryApiHandle",
          status: 400,
        },
        false,
      )
    }

    const route = routeParse(url.pathname)
    if (route === undefined) {
      const legacy = !url.pathname.startsWith("/api/v1/")
      return errorResponse(
        { code: "api.not-found", message: "The route was not found.", op: "projectRegistryApiHandle", status: 404 },
        legacy,
      )
    }
    if (route.kind === "self-access-logs" && context.transport !== "unix") {
      return errorResponse(
        { code: "api.not-found", message: "The route was not found.", op: "projectRegistryApiHandle", status: 404 },
        false,
      )
    }
    if (
      (context.transport === "http" && context.access === undefined) ||
      (context.transport === "unix" && (context.username === undefined || context.username === ""))
    ) {
      return errorResponse(
        {
          code: "api.unauthenticated",
          message: "Authentication is required.",
          op: "projectRegistryApiAuthenticate",
          status: 401,
        },
        route.legacy,
      )
    }
    const methods = routeMethods(route)
    if (!methods.includes(request.method)) {
      return errorResponse(
        {
          code: "api.method-not-allowed",
          message: `Supported methods: ${methods.join(", ")}.`,
          op: "projectRegistryApiHandle",
          status: 405,
        },
        route.legacy,
        { allow: methods.join(", ") },
      )
    }

    const username = context.username ?? ""
    let access = context.transport === "http" ? context.access : undefined
    if (context.transport === "unix" && routeRequiresProjectAccess(route)) {
      if (options.socketAccessResolve === undefined) {
        return errorResponse(
          {
            code: "api.unauthenticated",
            message: "Authentication is required.",
            op: "projectRegistryApiSocketAccessResolve",
            status: 401,
          },
          route.legacy,
        )
      }
      const accessR = await socketAccessBind(username, options.socketAccessResolve)
      if (!accessR.success) {
        return errorResponse(
          {
            code: "api.unauthenticated",
            message: "Authentication is required.",
            op: accessR.op,
            status: 401,
          },
          route.legacy,
        )
      }
      access = accessR.data
    }
    if (routeRequiresProjectAccess(route) && access === undefined) {
      return errorResponse(
        {
          code: "api.unauthenticated",
          message: "Authentication is required.",
          op: "projectRegistryApiAuthenticate",
          status: 401,
        },
        route.legacy,
      )
    }
    const resolvedAccess = access ?? requestAccessCreate(username)
    const owner = "owner" in route && route.owner !== undefined ? route.owner : username
    const useCaseOptions = { repository: options.repository, access: resolvedAccess, portRange: options.portRange }

    if (route.kind === "regenerate") {
      const regeneratedR = await options.caddyApplication.regenerate()
      if (!regeneratedR.success) return resultErrorResponse(regeneratedR, route.legacy, "caddy")
      return successResponse(regeneratedR.data)
    }

    if (route.kind === "docs") {
      const projectsR = await projectListUseCase(useCaseOptions, { owner })
      if (!projectsR.success) return resultErrorResponse(projectsR, route.legacy, "projects")
      const docsR = await projectDocsUrlsUseCase({
        actor: { subject: null, username, role: "own" },
        projectList: async () => createResult(projectsR.data.projects),
        owner,
        projectName: route.name,
        relativePath: url.searchParams.get("path") ?? "",
        scheme: url.searchParams.get("scheme") === "http" ? "http" : "https",
      })
      if (docsR.success) return successResponse(docsR.data)
      if (!docsR.errorMessage.startsWith("documentation")) {
        return resultErrorResponse(docsR, route.legacy, "projects")
      }

      const status =
        docsR.errorMessage === "documentation project is unavailable"
          ? 404
          : docsR.errorMessage.startsWith("documentation")
            ? 400
            : 500
      if (route.legacy) return legacyDocsErrorResponse(docsR, status)
      if (status === 404) {
        return errorResponse({ code: "projects.not-found", message: docsR.errorMessage, op: docsR.op, status }, false)
      }
      if (status === 400) {
        return errorResponse({ code: "request.invalid", message: docsR.errorMessage, op: docsR.op, status }, false)
      }
      return errorResponse(
        {
          code: "platform.internal",
          message: "The request could not be completed.",
          op: docsR.op,
          status: 500,
        },
        false,
      )
    }

    if (route.kind === "access-logs" || route.kind === "self-access-logs") {
      const inputR = accessLogInputParse(url)
      if (!inputR.success) {
        return errorResponse(
          { code: "access-log.invalid-input", message: inputR.errorMessage, op: inputR.op, status: 400 },
          false,
        )
      }
      const logsR = await projectAccessLogListUseCase(
        { repository: options.repository, access: resolvedAccess, source: projectAccessLogSource },
        { owner, name: route.name },
        inputR.data,
      )
      if (!logsR.success) return accessLogErrorResponse(logsR)
      return successResponse(logsR.data)
    }

    if (request.method !== "GET" && route.kind === "projects") {
      const body = await requestBodyJson(request, false)
      if (body instanceof Response) return body
      const bodyRecord = recordValue(body)
      if (bodyRecord !== undefined && typeof bodyRecord.owner === "string" && bodyRecord.owner.trim() !== owner) {
        return errorResponse(
          {
            code: "projects.forbidden",
            message: "Access is forbidden.",
            op: "projectRegistryApiCreate",
            status: 403,
          },
          false,
        )
      }
      const input = bodyRecord === undefined ? body : { ...bodyRecord, owner }
      const mutationR = await projectCreate(useCaseOptions, input, expectedRevision(body))
      if (!mutationR.success) return resultErrorResponse(mutationR, false, "projects")
      const applicationR = await caddyProjectChange(options.caddyApplication, mutationR.data)
      if (applicationR !== undefined && "success" in applicationR && !applicationR.success) {
        return resultErrorResponse(applicationR, false, "caddy")
      }
      return jsonResponse({ success: true, data: mutationR.data }, 201)
    }

    if (request.method !== "GET" && route.kind === "project") {
      const key = { owner, name: route.name }
      let mutationR: { success: true; data: ProjectRepositoryMutation } | ResultFailure

      if (request.method === "DELETE") {
        let mutationOptions: ProjectMutationOptions
        if (route.legacy) {
          const revisionR = await currentRevision(options.repository)
          if ("success" in revisionR) return resultErrorResponse(revisionR, true, "projects")
          mutationOptions = revisionR
        } else {
          const body = await requestBodyJson(request, false)
          if (body instanceof Response) return body
          mutationOptions = expectedRevision(body)
        }
        mutationR = await projectDelete(useCaseOptions, key, mutationOptions)
      } else {
        const body = await requestBodyJson(request, route.legacy)
        if (body instanceof Response) return body
        let input: unknown = body
        let mutationOptions: ProjectMutationOptions
        if (route.legacy) {
          const caddy = request.method === "PUT" ? legacyPutPatch(body) : legacyCaddyPatch(body)
          if (caddy === undefined) {
            return errorResponse(
              {
                code: "request.invalid",
                message:
                  request.method === "PUT"
                    ? "Port and domains are required on full replace."
                    : "The request body is invalid.",
                op: "projectRegistryApiLegacyEdit",
                status: 400,
              },
              true,
            )
          }
          input = request.method === "PUT" ? caddy : { caddy }
          const revisionR = await currentRevision(options.repository)
          if ("success" in revisionR) return resultErrorResponse(revisionR, true, "projects")
          mutationOptions = revisionR
        } else {
          const bodyRecord = recordValue(body)
          if (bodyRecord !== undefined && typeof bodyRecord.owner === "string" && bodyRecord.owner.trim() !== owner) {
            return errorResponse(
              {
                code: "projects.forbidden",
                message: "Access is forbidden.",
                op: "projectRegistryApiEdit",
                status: 403,
              },
              false,
            )
          }
          mutationOptions = expectedRevision(body)
        }
        mutationR = await projectEdit(useCaseOptions, key, input, mutationOptions)
      }

      if (!mutationR.success) return resultErrorResponse(mutationR, route.legacy, "projects")
      const applicationR = await caddyProjectChange(options.caddyApplication, mutationR.data)
      if (applicationR !== undefined && "success" in applicationR && !applicationR.success) {
        return resultErrorResponse(applicationR, route.legacy, "caddy")
      }
      if (!route.legacy) return successResponse(mutationR.data)
      if (request.method === "DELETE") return successResponse({ deleted: route.name })

      const projectR = await projectGetUseCase(useCaseOptions, key)
      if (!projectR.success) return resultErrorResponse(projectR, true, "projects")
      return successResponse(legacyProjectMap(projectR.data.project))
    }

    if (route.kind === "projects") {
      const projectsR = await projectListUseCase(useCaseOptions, { owner })
      if (!projectsR.success) return resultErrorResponse(projectsR, route.legacy, "projects")
      if (!route.legacy) return successResponse(projectsR.data)
      const projects = url.searchParams.get("templates") === "1" ? [] : projectsR.data.projects
      return successResponse(projects.map(legacyProjectMap))
    }

    if (route.kind === "project") {
      const projectR = await projectGetUseCase(useCaseOptions, { owner, name: route.name })
      if (!projectR.success) return resultErrorResponse(projectR, route.legacy, "projects")
      return successResponse(route.legacy ? legacyProjectMap(projectR.data.project) : projectR.data)
    }

    if (route.kind === "history") {
      const limit = historyLimitParse(url)
      if (limit === null) {
        return errorResponse(
          {
            code: "request.invalid",
            message: "History limit must be a positive integer.",
            op: "projectRegistryApiHistory",
            status: 400,
          },
          route.legacy,
        )
      }
      const queryNames = url.searchParams.getAll("name")
      if (route.legacy && queryNames.length > 1) {
        return errorResponse(
          {
            code: "request.invalid",
            message: "Project name is invalid.",
            op: "projectRegistryApiHistory",
            status: 400,
          },
          true,
        )
      }
      const rawName = route.name ?? queryNames[0]
      const name = rawName === undefined ? undefined : segmentDecode(rawName, projectNamePattern)
      if (rawName !== undefined && name === undefined) {
        return errorResponse(
          {
            code: "request.invalid",
            message: "Project name is invalid.",
            op: "projectRegistryApiHistory",
            status: 400,
          },
          route.legacy,
        )
      }
      if (name !== undefined) {
        const historyR = await projectHistory(useCaseOptions, { owner, name }, limit)
        if (!historyR.success) return resultErrorResponse(historyR, route.legacy, "projects")
        return successResponse(historyR.data)
      }
      const historyR = await options.repository.ownerHistory(owner, limit)
      if (!historyR.success) return resultErrorResponse(historyR, route.legacy, "projects")
      return successResponse(historyR.data)
    }

    if (route.kind === "config") {
      const selector = url.searchParams.get("select") ?? undefined
      const actor = { subject: null, username, role: "own" as const }
      const inspectionR = await caddyConfigInspectUseCase({
        actor,
        configOptions: options.configOptions,
        selector,
        projectList: async () => {
          const projectsR = await projectListUseCase(useCaseOptions, { owner: username })
          if (!projectsR.success) return projectsR
          return createResult(projectsR.data.projects)
        },
      })
      if (!inspectionR.success) return resultErrorResponse(inspectionR, route.legacy, "caddy")
      if (!route.legacy) return successResponse(inspectionR.data)

      const data =
        url.searchParams.get("summary") === "1"
          ? inspectionR.data.summary.map((entry) => legacySummaryMap(entry as unknown as Record<string, unknown>))
          : selector === undefined
            ? inspectionR.data.config
            : inspectionR.data.routes
      if (url.searchParams.get("pretty") === "1" && url.searchParams.get("summary") !== "1") {
        return new Response(JSON.stringify(data, null, 2), { status: 200, headers: responseHeaders })
      }
      return successResponse(data)
    }

    try {
      return successResponse(options.caddyApplication.status())
    } catch {
      return errorResponse(
        {
          code: "platform.internal",
          message: "Caddy status is unavailable.",
          op: "projectRegistryApiCaddyStatus",
          status: 500,
        },
        false,
      )
    }
  }

  return (request, context) =>
    Promise.resolve(handle(request, context)).catch(() => {
      let legacy = false
      try {
        legacy = !new URL(request.url).pathname.startsWith("/api/v1/")
      } catch {
        // Invalid URLs use the versioned error envelope.
      }
      return errorResponse(
        {
          code: "platform.internal",
          message: "The request could not be completed.",
          op: "projectRegistryApiHandle",
          status: 500,
        },
        legacy,
      )
    })
}
