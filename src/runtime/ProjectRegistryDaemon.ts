import type { PromiseResult } from "#result"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"
import type { ProjectRegistryDaemonHealth } from "./ProjectRegistryDaemonHealth.js"
import type { ProjectRegistryDaemonReadiness } from "./ProjectRegistryDaemonReadiness.js"
import type { ProjectRegistryDaemonSocketRefresh } from "./ProjectRegistryDaemonSocketRefresh.js"

export type ProjectRegistryDaemon = {
  readonly config: ProjectRegistryDaemonConfig
  readonly repository: ProjectRepository
  readonly caddyApplication: CaddyApplication
  start(): PromiseResult<void>
  shutdown(): PromiseResult<void>
  termination(): PromiseResult<void>
  healthLive(): ProjectRegistryDaemonHealth
  readiness(): PromiseResult<ProjectRegistryDaemonReadiness>
  refreshSockets(): PromiseResult<ProjectRegistryDaemonSocketRefresh>
}
