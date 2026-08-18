import type { CaddyConfigOptions } from "../caddy/caddyConfigOptionsSchema.js"
import type { ProjectPortRange } from "../project/projectPortNext.js"

export type ProjectRegistryDaemonConfig = {
  repositoryPath: string
  repositoryBranch: string
  mappedUsers: readonly string[]
  socketDirectory: string
  webListener: {
    hostname: "127.0.0.1" | "::1"
    port: number
  }
  caddyBinary: string
  caddyAdminUrl: string
  httpsListener: string
  oidc: CaddyConfigOptions["oidc"]
  portRange: ProjectPortRange
  gitPush: boolean
  regenerationIntervalMs: number
  userRefreshIntervalMs: number
  validationTimeoutMs: number
  loadTimeoutMs: number
  shutdownTimeoutMs: number
}
