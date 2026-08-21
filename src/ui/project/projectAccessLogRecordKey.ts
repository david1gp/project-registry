import type { ProjectAccessLogPage } from "./projectAccessLogPageSchema.js"

type ProjectAccessLogRecord = ProjectAccessLogPage["records"][number]

export function projectAccessLogRecordKey(record: ProjectAccessLogRecord): string {
  return JSON.stringify([
    record.timestamp,
    record.method,
    record.host,
    record.path,
    record.status,
    record.duration,
    record.responseBytes,
    record.clientNetwork,
  ])
}
