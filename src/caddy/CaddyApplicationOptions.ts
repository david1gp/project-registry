import type { PromiseResult } from "#result"
import type { Project } from "../project/Project.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { CaddyAdminLoadOptions } from "./CaddyAdminLoadOptions.js"
import type { CaddyClock } from "./CaddyClock.js"
import type { CaddyConfig } from "./CaddyConfig.js"
import type { CaddyConfigValidateOptions } from "./CaddyConfigValidateOptions.js"
import type { CaddyFetch } from "./CaddyFetch.js"
import type { CaddyTimer } from "./CaddyTimer.js"
import type { CaddyConfigOptions } from "./caddyConfigOptionsSchema.js"

export type CaddyApplicationOptions = {
  repository: Pick<ProjectRepository, "read">
  configOptions?: CaddyConfigOptions
  configReconcile?: (config: CaddyConfig, projects: readonly Project[]) => PromiseResult<CaddyConfig>
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
  initializeFromGeneratedConfig?: boolean
}
