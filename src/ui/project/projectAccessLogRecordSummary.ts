import type { ProjectAccessLogPage } from "./projectAccessLogPageSchema.js"

type ProjectAccessLogRecord = ProjectAccessLogPage["records"][number]

export function projectAccessLogRecordSummary(record: ProjectAccessLogRecord) {
  const request =
    typeof record.request === "object" && record.request !== null && !Array.isArray(record.request)
      ? record.request
      : undefined
  const numberValue = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
  const stringValue = (value: unknown) => (typeof value === "string" ? value : undefined)

  return {
    timestamp: numberValue(record.ts),
    method: stringValue(request?.method),
    host: stringValue(request?.host),
    path: stringValue(request?.uri),
    status: numberValue(record.status),
    duration: numberValue(record.duration),
    responseBytes: numberValue(record.size),
    clientNetwork: stringValue(request?.client_ip) ?? stringValue(request?.remote_ip),
  }
}
