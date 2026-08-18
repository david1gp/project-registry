import { createResultError, type Result } from "#result"
import { caddyConfigOptionsFromEnv } from "../caddy/caddyConfigOptionsFromEnv.js"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"

type Environment = Record<string, string | undefined>

function environmentInteger(environment: Environment, name: string): number | undefined {
  const value = environment[name]
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : Number.NaN
}

function environmentBoolean(environment: Environment, name: string): boolean | undefined {
  const value = environment[name]?.trim().toLowerCase()
  if (value === undefined || value === "") return undefined
  if (["1", "true", "yes", "on", "auto", "enabled"].includes(value)) return true
  if (["0", "false", "no", "off", "never", "disabled"].includes(value)) return false
  return undefined
}

export function projectRegistryDaemonConfigFromEnv(
  environment: unknown = Bun.env,
): Result<ProjectRegistryDaemonConfig> {
  const op = "projectRegistryDaemonConfigFromEnv"
  try {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      return createResultError(op, "invalid daemon environment")
    }
    const values = environment as Environment
    const names = [
      "PROJECT_REGISTRY_REPOSITORY_PATH",
      "PROJECT_REGISTRY_REPOSITORY_BRANCH",
      "PROJECT_REGISTRY_USERS",
      "PROJECT_REGISTRY_SOCKET_DIRECTORY",
      "PROJECT_REGISTRY_WEB_HOST",
      "PROJECT_REGISTRY_CADDY_BINARY",
      "PROJECT_REGISTRY_CADDY_ADMIN_URL",
      "PROJECT_REGISTRY_HTTPS_LISTENER",
      "PROJECT_REGISTRY_PORT_FROM",
      "PROJECT_REGISTRY_PORT_TO",
      "PROJECT_REGISTRY_WEB_PORT",
      "PROJECT_REGISTRY_REGENERATION_INTERVAL_MS",
      "PROJECT_REGISTRY_USER_REFRESH_INTERVAL_MS",
      "PROJECT_REGISTRY_VALIDATION_TIMEOUT_MS",
      "PROJECT_REGISTRY_LOAD_TIMEOUT_MS",
      "PROJECT_REGISTRY_SHUTDOWN_TIMEOUT_MS",
      "PROJECT_REGISTRY_GIT_PUSH",
    ]
    for (const name of names) {
      const value = values[name]
      if (value !== undefined && typeof value !== "string") return createResultError(op, `${name} must be a string`)
    }

    const repositoryPath = values.PROJECT_REGISTRY_REPOSITORY_PATH
    if (repositoryPath === undefined || repositoryPath.trim() === "") {
      return createResultError(op, "PROJECT_REGISTRY_REPOSITORY_PATH is required")
    }

    const oidcR = caddyConfigOptionsFromEnv(values)
    if (!oidcR.success) return oidcR
    const portFrom = environmentInteger(values, "PROJECT_REGISTRY_PORT_FROM")
    const portTo = environmentInteger(values, "PROJECT_REGISTRY_PORT_TO")
    const webPort = environmentInteger(values, "PROJECT_REGISTRY_WEB_PORT")
    const regenerationIntervalMs = environmentInteger(values, "PROJECT_REGISTRY_REGENERATION_INTERVAL_MS")
    const userRefreshIntervalMs = environmentInteger(values, "PROJECT_REGISTRY_USER_REFRESH_INTERVAL_MS")
    const validationTimeoutMs = environmentInteger(values, "PROJECT_REGISTRY_VALIDATION_TIMEOUT_MS")
    const loadTimeoutMs = environmentInteger(values, "PROJECT_REGISTRY_LOAD_TIMEOUT_MS")
    const shutdownTimeoutMs = environmentInteger(values, "PROJECT_REGISTRY_SHUTDOWN_TIMEOUT_MS")
    const gitPush = environmentBoolean(values, "PROJECT_REGISTRY_GIT_PUSH")

    const numericValues = [
      portFrom,
      portTo,
      webPort,
      regenerationIntervalMs,
      userRefreshIntervalMs,
      validationTimeoutMs,
      loadTimeoutMs,
      shutdownTimeoutMs,
    ]
    if (
      numericValues.some((value) => Number.isNaN(value)) ||
      (values.PROJECT_REGISTRY_GIT_PUSH !== undefined && gitPush === undefined)
    ) {
      return createResultError(op, "daemon environment contains an invalid number or boolean")
    }

    return projectRegistryDaemonConfigValidate({
      repositoryPath,
      repositoryBranch: values.PROJECT_REGISTRY_REPOSITORY_BRANCH,
      mappedUsers: values.PROJECT_REGISTRY_USERS?.split(",")
        .map((user) => user.trim())
        .filter(Boolean),
      socketDirectory: values.PROJECT_REGISTRY_SOCKET_DIRECTORY,
      webListener: {
        hostname: values.PROJECT_REGISTRY_WEB_HOST ?? "127.0.0.1",
        port: webPort ?? 8080,
      },
      caddyBinary: values.PROJECT_REGISTRY_CADDY_BINARY,
      caddyAdminUrl: values.PROJECT_REGISTRY_CADDY_ADMIN_URL,
      httpsListener: values.PROJECT_REGISTRY_HTTPS_LISTENER,
      oidc: oidcR.data.oidc,
      portRange: { from: portFrom ?? 3000, to: portTo ?? 3999 },
      gitPush,
      regenerationIntervalMs,
      userRefreshIntervalMs,
      validationTimeoutMs,
      loadTimeoutMs,
      shutdownTimeoutMs,
    })
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : "invalid daemon environment")
  }
}
