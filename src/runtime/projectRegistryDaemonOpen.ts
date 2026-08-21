import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { projectAccessCreate } from "../access/projectAccessCreate.js"
import { caddyApplicationCreate } from "../caddy/caddyApplicationCreate.js"
import { caddyProcessRunnerAsUser } from "../caddy/caddyProcessRunnerAsUser.js"
import { posixUserDirectoryCreate } from "../identity/posixUserDirectoryCreate.js"
import { projectRepositoryOpen } from "../project-store/projectRepositoryOpen.js"
import { sessionStoreCreate } from "../session/sessionStoreCreate.js"
import { tokenReferenceStoreCreate } from "../session/tokenReferenceStoreCreate.js"
import { zitadelIdentityDirectoryCreate } from "../zitadel/zitadelIdentityDirectoryCreate.js"
import type { ProjectRegistryDaemon } from "./ProjectRegistryDaemon.js"
import type { ProjectRegistryDaemonBrowserAuth } from "./ProjectRegistryDaemonBrowserAuth.js"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"
import type { ProjectRegistryDaemonOptions } from "./ProjectRegistryDaemonOptions.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"
import { projectRegistryDaemonCreate } from "./projectRegistryDaemonCreate.js"
import { projectRegistryDaemonPosixDefault } from "./projectRegistryDaemonPosixDefault.js"

function identityDependenciesCreate(
  options: ProjectRegistryDaemonOptions,
  config: ProjectRegistryDaemonConfig,
  posix: NonNullable<ProjectRegistryDaemonOptions["posix"]>,
): Result<ProjectRegistryDaemonBrowserAuth | undefined> {
  const op = "projectRegistryDaemonIdentityDependenciesCreate"
  if (options.browserAuth !== undefined) return createResult(options.browserAuth)
  if (config.zitadel === undefined) {
    return config.oidc === undefined
      ? createResult(undefined)
      : createResultError(op, "Zitadel runtime identity is not configured")
  }

  const identityR = zitadelIdentityDirectoryCreate({
    http: options.zitadelHttp ?? ((input, init) => globalThis.fetch(input, init)),
    issuer: config.zitadel.issuer,
    orgId: config.zitadel.orgId,
    projectId: config.zitadel.projectId,
    timeoutMs: config.loadTimeoutMs,
  })
  if (!identityR.success) return identityR

  const posixUsers = posixUserDirectoryCreate(posix)
  const tokenReferences =
    options.tokenReferences ?? tokenReferenceStoreCreate({ maxEntries: config.session.maxEntries })
  if (options.sessions !== undefined && options.tokenReferences === undefined) {
    return createResultError(op, "session storage must share its token-reference store")
  }
  const sessions =
    options.sessions ??
    sessionStoreCreate({
      tokenReferences,
      maxAgeSeconds: config.session.maxAgeSeconds,
      maxEntries: config.session.maxEntries,
    })
  return createResult({
    sessions,
    tokenReferences,
    identityDirectory: identityR.data,
    posixUsers,
    timeoutMs: config.loadTimeoutMs,
  })
}

function socketAccessResolveCreate(
  options: ProjectRegistryDaemonOptions,
  config: ProjectRegistryDaemonConfig,
  browserAuth: ProjectRegistryDaemonBrowserAuth | undefined,
): ProjectRegistryDaemonOptions["socketAccessResolve"] {
  if (options.socketAccessResolve !== undefined) return options.socketAccessResolve
  if (config.zitadel === undefined || browserAuth === undefined) return undefined
  const serviceToken = config.zitadel.serviceToken
  return async (username) =>
    createResult(
      projectAccessCreate({
        identityDirectory: browserAuth.identityDirectory,
        posixUsers: browserAuth.posixUsers,
        transport: {
          transport: "unix",
          username,
          accessToken: serviceToken,
          timeoutMs: browserAuth.timeoutMs,
        },
      }),
    )
}

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
  const caddyProcessRunner =
    options.caddyProcessRunner ??
    (config.caddyUser === undefined || config.caddyGroup === undefined
      ? undefined
      : caddyProcessRunnerAsUser(config.caddyUser, config.caddyGroup))
  const authR = identityDependenciesCreate(options, config, posix)
  if (!authR.success) return authR
  const socketAccessResolve = socketAccessResolveCreate(options, config, authR.data)
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
          configOptions: {
            httpsListener: config.httpsListener,
            oidc: config.oidc,
            ...(config.caddyAccessLogRoot === undefined ? {} : { caddyAccessLogRoot: config.caddyAccessLogRoot }),
          },
          caddyBin: config.caddyBinary,
          adminUrl: config.caddyAdminUrl,
          processRunner: caddyProcessRunner,
          fetch: options.caddyFetch,
          timer: options.timer,
          intervalMs: config.regenerationIntervalMs,
          validationTimeoutMs: config.validationTimeoutMs,
          loadTimeoutMs: config.loadTimeoutMs,
          initializeFromGeneratedConfig: config.initializeFromGeneratedConfig,
        })
      : createResult(options.caddyApplication)
  if (!caddyR.success) return caddyR

  return projectRegistryDaemonCreate({
    ...options,
    config,
    repository: repositoryR.data,
    caddyApplication: caddyR.data,
    posix,
    browserAuth: authR.data,
    ...(socketAccessResolve === undefined ? {} : { socketAccessResolve }),
  })
}
