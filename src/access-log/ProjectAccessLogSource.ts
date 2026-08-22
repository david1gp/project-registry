import type { PromiseResult, ResultErr } from "#result"
import type { ProjectKey } from "../project/projectKey.js"
import type { ProjectAccessLogRecord } from "./ProjectAccessLogRecord.js"

export type { ProjectAccessLogRecord } from "./ProjectAccessLogRecord.js"

export type ProjectAccessLogReadOptions = {
  limit?: number
  before?: string
}

export type ProjectAccessLogPage = {
  records: readonly ProjectAccessLogRecord[]
  next?: string
  partial: boolean
  malformedLines: number
}

export type ProjectAccessLogSourceErrorCode =
  | "access-log.invalid-input"
  | "access-log.invalid-cursor"
  | "access-log.cursor-expired"
  | "access-log.rotation-race"
  | "access-log.storage-unavailable"
  | "access-log.resource-limit"
  | "access-log.symlink"
  | "access-log.non-regular-file"

export type ProjectAccessLogSourceError = ResultErr & {
  code: ProjectAccessLogSourceErrorCode
}

export type ProjectAccessLogSource = {
  read(project: ProjectKey, options?: ProjectAccessLogReadOptions): PromiseResult<ProjectAccessLogPage>
}
