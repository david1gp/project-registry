import type { CaddyConfigOptions } from "../caddy/caddyConfigOptionsSchema.js"
import type { ProjectPortRange } from "../project/projectPortNext.js"

export type ProjectRegistryDaemonConfig = {
  repositoryPath: string
  repositoryBranch: string
  mappedUsers: readonly string[]
  defaultUserDomains: Readonly<Record<string, string>>
  socketDirectory: string
  webListener: {
    hostname: "127.0.0.1" | "::1"
    port: number
  }
  caddyBinary: string
  caddyAdminUrl: string
  caddyUser?: string
  caddyGroup?: string
  caddyAccessLogRoot?: string
  httpsListener: string
  oidc: CaddyConfigOptions["oidc"]
  zitadel?: {
    issuer: string
    orgId: string
    projectId: string
    serviceToken: string
  }
  session: {
    maxAgeSeconds?: number
    maxEntries?: number
  }
  portRange: ProjectPortRange
  gitPush: boolean
  regenerationIntervalMs: number
  userRefreshIntervalMs: number
  validationTimeoutMs: number
  loadTimeoutMs: number
  shutdownTimeoutMs: number
  initializeFromGeneratedConfig: boolean
}
