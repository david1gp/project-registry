import { createResult, createResultError, type PromiseResult } from "#result"
import { caddyApplicationCreate } from "../caddy/caddyApplicationCreate.js"
import { projectRepositoryOpen } from "../project-store/projectRepositoryOpen.js"
import type { ProjectRegistryDaemon } from "./ProjectRegistryDaemon.js"
import type { ProjectRegistryDaemonOptions } from "./ProjectRegistryDaemonOptions.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"
import { projectRegistryDaemonCreate } from "./projectRegistryDaemonCreate.js"
import { projectRegistryDaemonPosixDefault } from "./projectRegistryDaemonPosixDefault.js"

export async function projectRegistryDaemonOpen(
  options: ProjectRegistryDaemonOptions,
): PromiseResult<ProjectRegistryDaemon> {
  const op = "projectRegistryDaemonOpen"
  const configR = projectRegistryDaemonConfigValidate(options.config)
  if (!configR.success) return configR

  const posix = options.posix ?? projectRegistryDaemonPosixDefault()
  if (options.requireRoot !== false) {
    try {
      const root = posix.isRoot()
      if (!(await root)) return createResultError(op, "project-registryd must run as root")
    } catch {
      return createResultError(op, "root privilege check failed")
    }
  }

  const config = configR.data
  const repositoryR =
    options.repository === undefined
      ? await projectRepositoryOpen({
          dir: config.repositoryPath,
          branch: config.repositoryBranch,
          autoPush: config.gitPush,
        })
      : createResult(options.repository)
  if (!repositoryR.success) return repositoryR

  const caddyR =
    options.caddyApplication === undefined
      ? caddyApplicationCreate({
          repository: repositoryR.data,
          configOptions: { httpsListener: config.httpsListener, oidc: config.oidc },
          caddyBin: config.caddyBinary,
          adminUrl: config.caddyAdminUrl,
          processRunner: options.caddyProcessRunner,
          fetch: options.caddyFetch,
          timer: options.timer,
          intervalMs: config.regenerationIntervalMs,
          validationTimeoutMs: config.validationTimeoutMs,
          loadTimeoutMs: config.loadTimeoutMs,
        })
      : createResult(options.caddyApplication)
  if (!caddyR.success) return caddyR

  return projectRegistryDaemonCreate({
    ...options,
    config,
    repository: repositoryR.data,
    caddyApplication: caddyR.data,
    posix,
  })
}
