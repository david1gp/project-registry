import type { PromiseResult, Result } from "#result"
import type { CaddyApplicationResult } from "./CaddyApplicationResult.js"
import type { CaddyApplicationStatus } from "./CaddyApplicationStatus.js"

export type CaddyApplication = {
  start(): PromiseResult<CaddyApplicationResult>
  startup(): PromiseResult<CaddyApplicationResult>
  regenerate(): PromiseResult<CaddyApplicationResult>
  projectChange(): PromiseResult<CaddyApplicationResult>
  status(): CaddyApplicationStatus
  // The production application returns a drain Result; void remains supported
  // for existing injected applications, not as external drain evidence.
  stop(): Promise<void | Result<void>>
}
