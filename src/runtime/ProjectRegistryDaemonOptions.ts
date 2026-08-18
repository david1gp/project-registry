import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { CaddyFetch } from "../caddy/CaddyFetch.js"
import type { CaddyProcessRunner } from "../caddy/CaddyProcessRunner.js"
import type { CaddyTimer } from "../caddy/CaddyTimer.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRegistryDaemonFilesystem } from "./ProjectRegistryDaemonFilesystem.js"
import type { ProjectRegistryDaemonMappedUsersResolve } from "./ProjectRegistryDaemonMappedUsersResolve.js"
import type { ProjectRegistryDaemonPosix } from "./ProjectRegistryDaemonPosix.js"
import type { ProjectRegistryDaemonRequestHandler } from "./ProjectRegistryDaemonRequestHandler.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import type { ProjectRegistryDaemonSignals } from "./ProjectRegistryDaemonSignals.js"

export type ProjectRegistryDaemonOptions = {
  config: unknown
  repository?: ProjectRepository
  caddyApplication?: CaddyApplication
  mappedUsersResolve?: ProjectRegistryDaemonMappedUsersResolve
  requestHandler?: ProjectRegistryDaemonRequestHandler
  filesystem?: ProjectRegistryDaemonFilesystem
  posix?: ProjectRegistryDaemonPosix
  serverFactory?: ProjectRegistryDaemonServerFactory
  signals?: ProjectRegistryDaemonSignals
  timer?: CaddyTimer
  caddyProcessRunner?: CaddyProcessRunner
  caddyFetch?: CaddyFetch
  requireRoot?: boolean
}
