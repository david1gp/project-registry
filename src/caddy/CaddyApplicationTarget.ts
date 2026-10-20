import type { PromiseResult } from "#result"
import type { Project } from "../project/Project.js"
import type { CaddyConfig } from "./CaddyConfig.js"
import type { CaddyConfigOptions } from "./caddyConfigOptionsSchema.js"

export type CaddyApplicationTarget = {
  adminUrl: string
  /** Visibility is selected by the target key; an explicit value must match it. */
  configOptions?: CaddyConfigOptions
  /** Merge this instance's baseline here, including its admin listen address. */
  configReconcile?: (config: CaddyConfig, projects: readonly Project[]) => PromiseResult<CaddyConfig>
  caddyBin?: string
}
