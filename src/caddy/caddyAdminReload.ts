import type { PromiseResult } from "#result"
import { caddyAdminLoad } from "./caddyAdminLoad.js"

export function caddyAdminReload(config: unknown, options: unknown = {}, fetchOverride?: unknown): PromiseResult<true> {
  return caddyAdminLoad(config, options, fetchOverride)
}
