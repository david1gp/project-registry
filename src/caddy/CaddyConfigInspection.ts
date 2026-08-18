import type { CaddyConfig } from "./CaddyConfig.js"
import type { CaddyConfigSummaryEntry } from "./CaddyConfigSummaryEntry.js"

export type CaddyConfigInspection = {
  config: CaddyConfig
  summary: CaddyConfigSummaryEntry[]
  routes: unknown[]
  projectCount: number
  routeCount: number
}
