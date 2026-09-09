import type { CloudflareDnsFetch } from "./CloudflareDnsFetch.js"
import type { CloudflareDnsTrackedRecord } from "./CloudflareDnsTrackedRecord.js"

export type CloudflareDnsDeleteByIdOptions = {
  token: string
  record: CloudflareDnsTrackedRecord
  timeoutMs?: number
  signal?: AbortSignal
  fetch?: CloudflareDnsFetch
  apiBaseUrl?: string
}
