import type { ProjectAccessLogPage } from "./projectAccessLogPageSchema.js"

type ProjectAccessLogRecord = ProjectAccessLogPage["records"][number]

export function projectAccessLogRecordKey(record: ProjectAccessLogRecord): string {
  return JSON.stringify(record)
}
