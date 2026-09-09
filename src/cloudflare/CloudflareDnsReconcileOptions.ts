import type { CloudflareDnsFetch } from "./CloudflareDnsFetch.js"

export type CloudflareDnsReconcileOptions = {
  token: string
  hostname: string
  address: string
  timeoutMs?: number
  signal?: AbortSignal
  fetch?: CloudflareDnsFetch
  apiBaseUrl?: string
}
