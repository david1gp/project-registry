import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { CaddyAdminLoadOptions } from "./CaddyAdminLoadOptions.js"
import type { CaddyClock } from "./CaddyClock.js"
import type { CaddyConfigValidateOptions } from "./CaddyConfigValidateOptions.js"
import type { CaddyFetch } from "./CaddyFetch.js"
import type { CaddyTimer } from "./CaddyTimer.js"
import type { CaddyConfigOptions } from "./caddyConfigOptionsSchema.js"

export type CaddyApplicationOptions = {
  repository: Pick<ProjectRepository, "read">
  configOptions?: CaddyConfigOptions
  caddyBin?: CaddyConfigValidateOptions["caddyBin"]
  adminUrl?: CaddyAdminLoadOptions["adminUrl"]
  processRunner?: CaddyConfigValidateOptions["processRunner"]
  fetch?: CaddyFetch
  clock?: CaddyClock
  timer?: CaddyTimer
  intervalMs?: number
  maxRetries?: number
  retryDelayMs?: number
  validationTimeoutMs?: CaddyConfigValidateOptions["timeoutMs"]
  loadTimeoutMs?: CaddyAdminLoadOptions["timeoutMs"]
}
