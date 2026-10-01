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
      "PROJECT_REGISTRY_MODE",
      "PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED",
      "PROJECT_REGISTRY_LOCAL_MKCERT_BINARY",
      "PROJECT_REGISTRY_LOCAL_CERTIFICATES_STATE_DIRECTORY",
      "PROJECT_REGISTRY_LOCAL_HOSTS_FILE",
      "PROJECT_REGISTRY_REPOSITORY_BRANCH",
      "PROJECT_REGISTRY_USERS",
      "PROJECT_REGISTRY_DEFAULT_USER_DOMAINS",
      "PROJECT_REGISTRY_SOCKET_DIRECTORY",
      "PROJECT_REGISTRY_WEB_HOST",
      "PROJECT_REGISTRY_CADDY_BINARY",
      "PROJECT_REGISTRY_CADDY_ADMIN_URL",
      "PROJECT_REGISTRY_CADDY_BASE_CONFIG_PATH",
      "CADDY_USER",
      "CADDY_GROUP",
      "PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT",
      "PROJECT_REGISTRY_HTTPS_LISTENER",
      "ZITADEL_ISSUER",
      "ZITADEL_ORG_ID",
      "ZITADEL_PROJECT_ID",
      "ZITADEL_MANAGEMENT_TOKEN",
      "PROJECT_REGISTRY_PORT_FROM",
      "PROJECT_REGISTRY_PORT_TO",
      "PROJECT_REGISTRY_WEB_PORT",
      "PROJECT_REGISTRY_REGENERATION_INTERVAL_MS",
      "PROJECT_REGISTRY_USER_REFRESH_INTERVAL_MS",
      "PROJECT_REGISTRY_VALIDATION_TIMEOUT_MS",
      "PROJECT_REGISTRY_LOAD_TIMEOUT_MS",
      "PROJECT_REGISTRY_SHUTDOWN_TIMEOUT_MS",
      "PROJECT_REGISTRY_SESSION_MAX_AGE_SECONDS",
      "PROJECT_REGISTRY_SESSION_MAX_ENTRIES",
      "PROJECT_REGISTRY_GIT_PUSH",
      "PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG",
      "SERVER_IP",
      "PROJECT_REGISTRY_SERVER_IP_CACHE_PATH",
      "PROJECT_REGISTRY_SERVER_IP_DISCOVERY_TIMEOUT_MS",
      "PROJECT_REGISTRY_CLOUDFLARE_CREDENTIALS_DIR",
      "PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED",
    ]
    for (const name of names) {
      const value = values[name]
      if (value !== undefined && typeof value !== "string") return createResultError(op, `${name} must be a string`)
    }

    const repositoryPath = values.PROJECT_REGISTRY_REPOSITORY_PATH
    if (repositoryPath === undefined || repositoryPath.trim() === "") {
      return createResultError(op, "PROJECT_REGISTRY_REPOSITORY_PATH is required")
    }

    const mode = values.PROJECT_REGISTRY_MODE ?? "root"
    if (mode !== "root" && mode !== "user") {
      return createResultError(op, "PROJECT_REGISTRY_MODE must be 'root' or 'user'")
    }
    const home = values.HOME?.trim()
    const runtimeDirectory = values.XDG_RUNTIME_DIR?.trim()
    const stateDirectory = values.XDG_STATE_HOME?.trim() || (home ? `${home}/.local/state` : undefined)
    const configDirectory = values.XDG_CONFIG_HOME?.trim() || (home ? `${home}/.config` : undefined)
    const username = values.USER?.trim()
    if (mode === "user" && !username) {
      return createResultError(op, "USER is required in user mode")
    }
    if (mode === "user" && (runtimeDirectory === undefined || !runtimeDirectory.startsWith("/"))) {
      return createResultError(op, "XDG_RUNTIME_DIR must be an absolute path in user mode")
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
    const serverIpDiscoveryTimeoutMs = environmentInteger(values, "PROJECT_REGISTRY_SERVER_IP_DISCOVERY_TIMEOUT_MS")
    const sessionMaxAgeSeconds = environmentInteger(values, "PROJECT_REGISTRY_SESSION_MAX_AGE_SECONDS")
    const sessionMaxEntries = environmentInteger(values, "PROJECT_REGISTRY_SESSION_MAX_ENTRIES")
    const gitPush = environmentBoolean(values, "PROJECT_REGISTRY_GIT_PUSH")
    const initializeFromGeneratedConfig = environmentBoolean(
      values,
      "PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG",
    )
    const cloudflareDnsEnabled = environmentBoolean(values, "PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED")
    const localDomainsEnabled = environmentBoolean(values, "PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED")
    let defaultUserDomains: unknown
    const defaultUserDomainsValue = values.PROJECT_REGISTRY_DEFAULT_USER_DOMAINS?.trim()
    if (defaultUserDomainsValue !== undefined && defaultUserDomainsValue !== "") {
      try {
        defaultUserDomains = JSON.parse(defaultUserDomainsValue)
      } catch {
        return createResultError(op, "PROJECT_REGISTRY_DEFAULT_USER_DOMAINS must be valid JSON")
      }
    }
    const caddyAccessLogRoot =
      values.PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT?.trim() === ""
        ? undefined
        : values.PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT
    const caddyUser = values.CADDY_USER?.trim() === "" ? undefined : values.CADDY_USER
    const caddyGroup = values.CADDY_GROUP?.trim() === "" ? undefined : values.CADDY_GROUP
    const zitadelIssuer = values.ZITADEL_ISSUER?.trim() || oidcR.data.oidc?.issuer
    const zitadelValues = [
      values.ZITADEL_ISSUER,
      values.ZITADEL_ORG_ID,
      values.ZITADEL_PROJECT_ID,
      values.ZITADEL_MANAGEMENT_TOKEN,
    ]
    const zitadelConfigured = zitadelValues.some((value) => value !== undefined && value.trim() !== "")

    const numericValues = [
      portFrom,
      portTo,
      webPort,
      regenerationIntervalMs,
      userRefreshIntervalMs,
      validationTimeoutMs,
      loadTimeoutMs,
      shutdownTimeoutMs,
      sessionMaxAgeSeconds,
      sessionMaxEntries,
      serverIpDiscoveryTimeoutMs,
    ]
    if (
      numericValues.some((value) => Number.isNaN(value)) ||
      (values.PROJECT_REGISTRY_GIT_PUSH !== undefined && gitPush === undefined) ||
      (values.PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG !== undefined &&
        initializeFromGeneratedConfig === undefined) ||
      (values.PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED !== undefined && cloudflareDnsEnabled === undefined) ||
      (values.PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED !== undefined && localDomainsEnabled === undefined)
    ) {
      return createResultError(op, "daemon environment contains an invalid number or boolean")
    }

    return projectRegistryDaemonConfigValidate({
      mode,
      ...(localDomainsEnabled === true
        ? {
            localDomains: {
              mkcertBinary: values.PROJECT_REGISTRY_LOCAL_MKCERT_BINARY,
              stateDirectory: values.PROJECT_REGISTRY_LOCAL_CERTIFICATES_STATE_DIRECTORY,
              hostsFilePath: values.PROJECT_REGISTRY_LOCAL_HOSTS_FILE,
            },
          }
        : {}),
      repositoryPath,
      repositoryBranch: values.PROJECT_REGISTRY_REPOSITORY_BRANCH,
      mappedUsers: (values.PROJECT_REGISTRY_USERS ?? (mode === "user" ? username : undefined))?.split(",")
        .map((user) => user.trim())
        .filter(Boolean),
      ...(defaultUserDomains === undefined ? {} : { defaultUserDomains }),
      socketDirectory: values.PROJECT_REGISTRY_SOCKET_DIRECTORY ?? (mode === "user" ? `${runtimeDirectory}/project-registry` : undefined),
      webListener: {
        hostname: values.PROJECT_REGISTRY_WEB_HOST ?? "127.0.0.1",
        port: webPort ?? 8080,
      },
      caddyBinary: values.PROJECT_REGISTRY_CADDY_BINARY,
      caddyAdminUrl: values.PROJECT_REGISTRY_CADDY_ADMIN_URL,
      caddyBaseConfigPath: values.PROJECT_REGISTRY_CADDY_BASE_CONFIG_PATH,
      caddyUser,
      caddyGroup,
      caddyAccessLogRoot,
      httpsListener: values.PROJECT_REGISTRY_HTTPS_LISTENER,
      oidc: oidcR.data.oidc,
      ...(zitadelConfigured
        ? {
            zitadel: {
              issuer: zitadelIssuer,
              orgId: values.ZITADEL_ORG_ID,
              projectId: values.ZITADEL_PROJECT_ID,
              serviceToken: values.ZITADEL_MANAGEMENT_TOKEN,
            },
          }
        : {}),
      session: {
        ...(sessionMaxAgeSeconds === undefined ? {} : { maxAgeSeconds: sessionMaxAgeSeconds }),
        ...(sessionMaxEntries === undefined ? {} : { maxEntries: sessionMaxEntries }),
      },
      portRange: { from: portFrom ?? 3000, to: portTo ?? 3999 },
      gitPush,
      regenerationIntervalMs,
      userRefreshIntervalMs,
      validationTimeoutMs,
      loadTimeoutMs,
      shutdownTimeoutMs,
      initializeFromGeneratedConfig,
      serverIp: values.SERVER_IP?.trim() || undefined,
      serverIpCachePath:
        values.PROJECT_REGISTRY_SERVER_IP_CACHE_PATH?.trim() ||
        (mode === "user" && stateDirectory ? `${stateDirectory}/project-registry/server-ip` : undefined),
      serverIpDiscoveryTimeoutMs,
      cloudflareDns: {
        enabled: cloudflareDnsEnabled !== false,
        ...(!values.PROJECT_REGISTRY_CLOUDFLARE_CREDENTIALS_DIR?.trim()
          ? mode === "user" && configDirectory
            ? { credentialsDirectory: `${configDirectory}/project-registry/cloudflare` }
            : {}
          : { credentialsDirectory: values.PROJECT_REGISTRY_CLOUDFLARE_CREDENTIALS_DIR?.trim() }),
      },
    })
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : "invalid daemon environment")
  }
}
