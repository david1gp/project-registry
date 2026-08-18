import type { CaddyFetch } from "./CaddyFetch.js"
import type { CaddyTimer } from "./CaddyTimer.js"

export type CaddyAdminLoadOptions = {
  adminUrl?: string
  fetch?: CaddyFetch
  timeoutMs?: number
  signal?: AbortSignal
  timer?: CaddyTimer
}
