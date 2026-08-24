import { createResult, createResultError, type PromiseResult } from "#result"
import type { CaddyConfigInspection } from "./CaddyConfigInspection.js"
import type { CaddyConfigInspectUseCaseOptions } from "./CaddyConfigInspectUseCaseOptions.js"
import { caddyConfigInspect } from "./caddyConfigInspect.js"
import { caddyVisibleProjects } from "./caddyVisibleProjects.js"

export async function caddyConfigInspectUseCase(
  options: CaddyConfigInspectUseCaseOptions,
): PromiseResult<CaddyConfigInspection> {
  const op = "caddyConfigInspectUseCase"
  try {
    const visibleR = await caddyVisibleProjects(options)
    if (!visibleR.success) return visibleR
    const inspectionR = caddyConfigInspect(visibleR.data, options.configOptions, options.selector)
    if (!inspectionR.success) return { ...inspectionR, op }
    return createResult(inspectionR.data)
  } catch {
    return createResultError(op, "Caddy inspection input is invalid")
  }
}
