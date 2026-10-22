import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { ProjectKey } from "../project/projectKey.js"
import { projectGetUseCase } from "../project/projectGetUseCase.js"
import type { ProjectUseCaseOptions } from "../project/ProjectUseCaseOptions.js"
import { routeCheckProbe, type RouteCheckProbeRow } from "./routeCheckProbe.js"

export type RouteCheckUseCaseKey = ProjectKey & { service?: string }

export type RouteCheckUseCaseRow = RouteCheckProbeRow & { service: string }

export type RouteCheckUseCaseResult = {
  project: string
  service: string | undefined
  rows: RouteCheckUseCaseRow[]
}

export type RouteCheckUseCaseDeps = {
  probe?: typeof routeCheckProbe
}

/**
 * Read-only route check for one project: loads the caller's project (owner
 * authorization enforced by the project use case), collects every served
 * service's domains — skipping disabled services and empty domain lists —
 * and probes each hostname from this host's view. Only hostnames registered
 * on the caller's own project are ever probed.
 */
export async function routeCheckUseCase(
  options: ProjectUseCaseOptions,
  key: RouteCheckUseCaseKey,
  deps: RouteCheckUseCaseDeps = {},
): PromiseResult<RouteCheckUseCaseResult> {
  const op = "routeCheckUseCase"
  const probe = deps.probe ?? routeCheckProbe
  const projectR = await projectGetUseCase(options, { owner: key.owner, name: key.name })
  if (!projectR.success) return projectR
  const served = projectR.data.project.services.filter(
    (service) =>
      service.caddy !== null &&
      service.caddy !== undefined &&
      !service.caddy.disabled &&
      service.caddy.domains.length > 0,
  )
  const selected = key.service === undefined ? served : served.filter((service) => service.id === key.service)
  if (selected.length === 0) {
    if (key.service === undefined) return createResult({ project: key.name, service: undefined, rows: [] })
    return {
      ...createResultErrorCode(
        op,
        `Service '${key.service}' was not found on project '${key.name}'.`,
        "route-check.service-not-found",
      ),
    }
  }
  const rows: RouteCheckUseCaseRow[] = []
  for (const service of selected) {
    const domains = service.caddy?.domains ?? []
    for (const hostname of domains) {
      const rowR = await probe(hostname)
      if (!rowR.success) return rowR
      rows.push({ ...rowR.data, service: service.id })
    }
  }
  return createResult({ project: key.name, service: key.service, rows })
}
