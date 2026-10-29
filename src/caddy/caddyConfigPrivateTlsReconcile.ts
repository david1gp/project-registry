import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"
import { projectLocalCaddyEntries } from "../project/projectLocalCaddyEntries.js"
import { projectPrivateTlsAutomationRender } from "../project/projectPrivateTlsAutomation.js"
import { type ProjectPrivateTlsGateSnapshot, projectPrivateTlsGateDecide } from "../project/projectPrivateTlsGate.js"
import type { CaddyConfig } from "./CaddyConfig.js"

type TlsMerge = {
  policies: Array<Record<string, unknown>>
  subjects: string[]
  automate: string[]
  automation: Record<string, unknown>
  certificates: Record<string, unknown>
}

function tlsMergeRead(tls: unknown, op: string): Result<TlsMerge> {
  if (tls === undefined) {
    return createResult({ policies: [], subjects: [], automate: [], automation: {}, certificates: {} })
  }
  if (typeof tls !== "object" || tls === null || Array.isArray(tls)) {
    return createResultError(op, "existing private TLS configuration is not an object; refusing")
  }
  const record = tls as Record<string, unknown>
  const automation = record.automation
  const certificates = record.certificates
  if (
    automation !== undefined &&
    (typeof automation !== "object" || automation === null || Array.isArray(automation))
  ) {
    return createResultError(op, "existing private TLS automation is not an object; refusing")
  }
  if (
    certificates !== undefined &&
    (typeof certificates !== "object" || certificates === null || Array.isArray(certificates))
  ) {
    return createResultError(op, "existing private TLS certificates section is not an object; refusing")
  }
  const rawPolicies = (automation as Record<string, unknown> | undefined)?.policies ?? []
  if (!Array.isArray(rawPolicies)) {
    return createResultError(op, "existing private TLS automation policies are not a list; refusing")
  }
  const policies: Array<Record<string, unknown>> = []
  const subjects: string[] = []
  for (const policy of rawPolicies) {
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      return createResultError(op, "existing private TLS automation policy is not an object; refusing")
    }
    const record = policy as Record<string, unknown>
    if (!Array.isArray(record.subjects) || record.subjects.some((entry) => typeof entry !== "string")) {
      return createResultError(op, "existing private TLS automation policy has no hostname subject list; refusing")
    }
    policies.push(record)
    subjects.push(...(record.subjects as string[]))
  }
  const rawAutomate = (certificates as Record<string, unknown> | undefined)?.automate ?? []
  if (!Array.isArray(rawAutomate) || rawAutomate.some((entry) => typeof entry !== "string")) {
    return createResultError(op, "existing private TLS automate loader is not a hostname list; refusing")
  }
  return createResult({
    policies,
    subjects,
    automate: [...(rawAutomate as string[])],
    automation: { ...((automation as Record<string, unknown> | undefined) ?? {}) },
    certificates: { ...((certificates as Record<string, unknown> | undefined) ?? {}) },
  })
}

function routeHosts(route: unknown): string[] | undefined {
  if (typeof route !== "object" || route === null || Array.isArray(route)) return undefined
  const match = (route as Record<string, unknown>).match
  if (!Array.isArray(match)) return undefined
  const hosts: string[] = []
  for (const matcher of match) {
    if (typeof matcher !== "object" || matcher === null || Array.isArray(matcher)) return undefined
    const list = (matcher as Record<string, unknown>).host
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) return undefined
    hosts.push(...(list as string[]))
  }
  return hosts
}

/**
 * Install the TLS enrollment set onto the private Caddy config and gate
 * its routes, mirroring the `~/ds` `leoBatchTlsPrepare` ordering: enroll
 * on the zero-route baseline first (the `automate` loader issues
 * certificates even with zero routes), prove trusted handshakes, and
 * only then move routes.
 *
 * Per regenerate: render the enrollment set from the registry projects,
 * union it onto any base TLS (the reviewed zero-route baseline keeps its
 * wildcard policies; rendered exact-host subjects must be disjoint from
 * them), and withhold every route serving a private name whose
 * enrollment is not proven by the tracker snapshot. Withholding (not
 * failing) is what breaks the enrollment chicken-and-egg: the loader
 * must load before proof is possible.
 *
 * Disabled routes are never touched (generation already excludes them);
 * names outside the registry desired set (legacy base routes) pass
 * through; while disabled the input config is returned unchanged.
 */
export function caddyConfigPrivateTlsReconcileCreate(options: {
  enabled: boolean
  snapshotCurrent: () => ProjectPrivateTlsGateSnapshot
  tokenEnvVars?: unknown
  resolvers?: unknown
  privateListenerAddresses?: readonly unknown[]
  op?: string
}): Result<(config: CaddyConfig, projects: readonly Project[]) => PromiseResult<CaddyConfig>> {
  const op = options?.op ?? "caddyConfigPrivateTlsReconcile"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "private TLS reconcile options are required")
  }
  if (typeof options.enabled !== "boolean")
    return createResultError(op, "private TLS reconcile enabled flag is invalid")
  if (typeof options.snapshotCurrent !== "function") {
    return createResultError(op, "private TLS reconcile gate snapshot accessor is invalid")
  }
  const enabled = options.enabled
  const snapshotCurrent = options.snapshotCurrent
  const tokenEnvVars = options.tokenEnvVars
  const resolvers = options.resolvers
  const privateListenerAddresses = options.privateListenerAddresses

  return createResult(async (config, projects) => {
    if (!enabled) return createResult(config)
    if (typeof config !== "object" || config === null) {
      return createResultError(op, "private TLS reconcile configuration is invalid")
    }
    if (!Array.isArray(projects)) return createResultError(op, "private TLS reconcile projects are invalid")

    const namesByOwner = new Map<string, Set<string>>()
    for (const project of projects) {
      if (typeof project !== "object" || project === null) continue
      const owner = (project as Project).owner
      if (typeof owner !== "string" || owner.trim() === "") continue
      let owned = namesByOwner.get(owner)
      if (owned === undefined) {
        owned = new Set<string>()
        namesByOwner.set(owner, owned)
      }
      for (const entry of projectLocalCaddyEntries(project as Project)) {
        if (entry.caddy.disabled) continue
        if (entry.caddy.networkVisibility !== "private") continue
        for (const domain of entry.caddy.domains) {
          const normalized = projectDomainNormalize(domain)
          if (normalized !== "") owned.add(normalized)
        }
      }
    }
    const claims = [...namesByOwner]
      .filter(([, names]) => names.size > 0)
      .map(([owner, names]) => ({ owner, hostnames: [...names] }))
    if (claims.length === 0) return createResult(config)

    const renderedR = projectPrivateTlsAutomationRender({
      claims,
      ...(tokenEnvVars === undefined ? {} : { tokenEnvVars }),
      ...(resolvers === undefined ? {} : { resolvers }),
      ...(privateListenerAddresses === undefined ? {} : { privateAddresses: privateListenerAddresses }),
      op,
    })
    if (!renderedR.success) return renderedR
    const rendered = renderedR.data

    const existingR = tlsMergeRead((config as CaddyConfig).apps?.tls, op)
    if (!existingR.success) return existingR
    const existing = existingR.data
    const existingSubjects = new Set(existing.subjects)
    for (const hostname of rendered.enrolled) {
      if (existingSubjects.has(hostname)) {
        return createResultError(
          op,
          `private TLS subject "${hostname}" is already covered by the base TLS configuration; refusing`,
        )
      }
    }

    let snapshot: ProjectPrivateTlsGateSnapshot
    try {
      snapshot = snapshotCurrent()
    } catch {
      return createResultError(op, "private TLS gate snapshot is unavailable; refusing to serve private routes")
    }
    const gateR = projectPrivateTlsGateDecide({
      hostnames: [...rendered.enrolled, ...rendered.wildcardCovered],
      snapshot,
      op,
    })
    if (!gateR.success) return gateR
    const refused = new Set(gateR.data.refused.map((entry) => entry.hostname))

    const typed = config as CaddyConfig
    const srv0 = typed.apps?.http?.servers?.srv0
    if (srv0 === undefined || typeof srv0 !== "object" || srv0 === null) {
      return createResultError(op, "private TLS reconcile server configuration is invalid")
    }
    let routes: unknown[] | undefined
    if (refused.size > 0 && Array.isArray(srv0.routes)) {
      const filtered = srv0.routes.filter((route) => {
        const hosts = routeHosts(route)
        if (hosts === undefined) return true
        return !hosts.some((host) => refused.has(host))
      })
      if (filtered.length !== srv0.routes.length) routes = filtered
    }

    const renderedEmpty = rendered.tls.automation.policies.length === 0 && rendered.enrolled.length === 0
    const tls =
      renderedEmpty && (config as CaddyConfig).apps?.tls === undefined
        ? undefined
        : {
            ...(config as CaddyConfig).apps?.tls,
            ...(renderedEmpty
              ? {}
              : {
                  automation: {
                    ...existing.automation,
                    policies: [...existing.policies, ...rendered.tls.automation.policies],
                  },
                  certificates: {
                    ...existing.certificates,
                    automate: [...new Set([...existing.automate, ...rendered.tls.certificates.automate])].sort(),
                  },
                }),
          }
    return createResult({
      ...typed,
      apps: {
        ...typed.apps,
        tls,
        http: {
          ...typed.apps?.http,
          servers: {
            ...typed.apps?.http?.servers,
            ...(routes === undefined ? {} : { srv0: { ...srv0, routes } }),
          },
        },
      },
    })
  })
}
