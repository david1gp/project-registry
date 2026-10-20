import type { PromiseResult } from "#result"
import type { CloudflareDnsFetch } from "./CloudflareDnsFetch.js"
import type { CloudflareDnsTrackedRecord } from "./CloudflareDnsTrackedRecord.js"

export type CloudflareDnsDeleteByIdOptions = {
  token: string
  record: CloudflareDnsTrackedRecord
  /** Recheck current desired state after record verification, immediately before DELETE. */
  beforeDelete?: () => PromiseResult<boolean>
  timeoutMs?: number
  signal?: AbortSignal
  fetch?: CloudflareDnsFetch
  apiBaseUrl?: string
}
