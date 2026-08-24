import { createResult, createResultError, type PromiseResult, type Result, type ResultErr } from "#result"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import { projectGetUseCase } from "../project/projectGetUseCase.js"
import type { ProjectKey } from "../project/projectKey.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type {
  ProjectAccessLogPage,
  ProjectAccessLogReadOptions,
  ProjectAccessLogSource,
  ProjectAccessLogSourceErrorCode,
} from "./ProjectAccessLogSource.js"

const defaultLimit = 100
const maximumLimit = 1_000
const maximumCursorLength = 4_096

export type ProjectAccessLogListUseCaseOptions = {
  repository: ProjectRepository
  access: ProjectAccess
  source?: ProjectAccessLogSource
}

export type ProjectAccessLogListInput = ProjectAccessLogReadOptions

export type ProjectAccessLogListErrorCode =
  | "access-log.not-found"
  | "access-log.unavailable"
  | "access-log.invalid-input"
  | "access-log.invalid-cursor"
  | "access-log.cursor-expired"
  | "access-log.rotation-race"
  | "access-log.storage-unavailable"
  | "access-log.resource-limit"
  | "access-log.symlink"
  | "access-log.non-regular-file"

type ProjectAccessLogListFailure = ResultErr & { code: ProjectAccessLogListErrorCode }

function listError(
  code: ProjectAccessLogListErrorCode,
  message: string,
  errorData?: string,
): ProjectAccessLogListFailure {
  return { ...createResultError("projectAccessLogListUseCase", message, errorData), code }
}

function inputValidate(input: unknown): Result<{ limit: number; before?: string }> {
  if (input === undefined) return createResult({ limit: defaultLimit })
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return listError("access-log.invalid-input", "Access-log paging input is invalid.")
  }

  const value = input as Record<string, unknown>
  const limit = value.limit ?? defaultLimit
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > maximumLimit) {
    return listError("access-log.invalid-input", "Access-log limit must be a positive bounded integer.")
  }

  const before = value.before
  if (
    before !== undefined &&
    (typeof before !== "string" || before.length === 0 || before.length > maximumCursorLength)
  ) {
    return listError("access-log.invalid-input", "Access-log cursor is invalid.")
  }

  return createResult({ limit: limit as number, ...(before === undefined ? {} : { before }) })
}

function projectFailureCode(code: unknown): ProjectAccessLogListErrorCode {
  if (code === "projects.not-found" || code === "projects.forbidden") {
    return "access-log.not-found"
  }
  return "access-log.unavailable"
}

function sourceFailureCode(value: unknown): ProjectAccessLogListErrorCode {
  if (typeof value !== "object" || value === null || !("code" in value)) return "access-log.unavailable"
  const code = value.code
  const sourceCodes: readonly ProjectAccessLogSourceErrorCode[] = [
    "access-log.invalid-input",
    "access-log.invalid-cursor",
    "access-log.cursor-expired",
    "access-log.rotation-race",
    "access-log.storage-unavailable",
    "access-log.resource-limit",
    "access-log.symlink",
    "access-log.non-regular-file",
  ]
  return typeof code === "string" && sourceCodes.includes(code as ProjectAccessLogSourceErrorCode)
    ? (code as ProjectAccessLogListErrorCode)
    : "access-log.unavailable"
}

export async function projectAccessLogListUseCase(
  options: ProjectAccessLogListUseCaseOptions,
  key: ProjectKey,
  input: ProjectAccessLogListInput = {},
): PromiseResult<ProjectAccessLogPage> {
  const inputR = inputValidate(input)
  if (!inputR.success) return inputR

  const projectR = await projectGetUseCase(options, key)
  if (!projectR.success) return listError(projectFailureCode(projectR.code), "Project access logs are unavailable.")

  const caddy = projectR.data.project.caddy
  if (caddy === undefined || caddy === null || caddy.disabled) {
    return listError("access-log.unavailable", "Project access logging is unavailable.")
  }
  if (options.source === undefined) {
    return listError("access-log.unavailable", "Project access logging is unavailable.")
  }

  const pageR = await options.source.read(key, inputR.data)
  if (!pageR.success) {
    return {
      ...pageR,
      code: sourceFailureCode(pageR),
    }
  }
  return createResult(pageR.data)
}
