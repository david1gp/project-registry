import type { PromiseResult } from "#result"
import type { CaddyApplicationResult } from "./CaddyApplicationResult.js"
import type { CaddyApplicationStatus } from "./CaddyApplicationStatus.js"

export type CaddyApplication = {
  start(): PromiseResult<CaddyApplicationResult>
  startup(): PromiseResult<CaddyApplicationResult>
  regenerate(): PromiseResult<CaddyApplicationResult>
  projectChange(): PromiseResult<CaddyApplicationResult>
  status(): CaddyApplicationStatus
  stop(): Promise<void>
}
