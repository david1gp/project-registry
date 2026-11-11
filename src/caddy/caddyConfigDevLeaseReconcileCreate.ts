import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { DevLeaseRecord } from "../dev/devLeaseRecordSchema.js"
import type { CaddyConfig } from "./CaddyConfig.js"

function leaseRoute(lease: DevLeaseRecord): Record<string, unknown> {
  return {
    match: [{ host: [lease.hostname] }],
    terminal: true,
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            handle: [
              {
                handler: "headers",
                response: {
                  set: {
                    Routed: [`dev-${lease.user}-${lease.projectKey.name}`],
                  },
                },
              },
            ],
          },
          {
            handle: [
              {
                handler: "reverse_proxy",
                // 127.0.0.1, not localhost: the unit pins HOST=127.0.0.1 and a
                // localhost dial could resolve to ::1 first and miss the server.
                upstreams: [{ dial: `127.0.0.1:${lease.port}` }],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * Append active dev-lease routes to the PRIVATE target only. The route shape
 * mirrors the generated proxy route (Routed header + reverse proxy) minus
 * OIDC/docs handling: the tailnet boundary is the access control, and lease
 * hostnames are covered by the live wildcard certificate.
 *
 * Lease hostnames flow through the existing post-merge hostname-conflict
 * guard in the Caddy application (it scans the final reconciled configs):
 * a lease colliding with a row domain fails the regenerate loudly instead of
 * silently shadowing the row. Up-time claim validation prevents that case;
 * the guard is defense in depth for rows added later.
 *
 * An empty lease table returns the input config reference unchanged, so the
 * generated config stays byte-identical to today while the flag is dark.
 */
export function caddyConfigDevLeaseReconcileCreate(options: {
  enabled: boolean
  leasesCurrent: () => PromiseResult<readonly DevLeaseRecord[]>
  op?: string
}): Result<(config: CaddyConfig, projects: readonly unknown[]) => PromiseResult<CaddyConfig>> {
  const op = options?.op ?? "caddyConfigDevLeaseReconcile"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "dev lease reconcile options are required")
  }
  if (typeof options.enabled !== "boolean") {
    return createResultError(op, "dev lease reconcile enabled flag is invalid")
  }
  if (typeof options.leasesCurrent !== "function") {
    return createResultError(op, "dev lease reconcile lease accessor is invalid")
  }
  const enabled = options.enabled
  const leasesCurrent = options.leasesCurrent

  return createResult(async (config, _projects) => {
    if (!enabled) return createResult(config)
    if (typeof config !== "object" || config === null) {
      return createResultError(op, "dev lease reconcile configuration is invalid")
    }
    const leasesR = await leasesCurrent()
    if (!leasesR.success) return leasesR
    const active = leasesR.data
      .filter((lease) => lease.state === "active")
      .sort((left, right) => (left.hostname < right.hostname ? -1 : left.hostname > right.hostname ? 1 : 0))
    if (active.length === 0) return createResult(config)
    const typed = config as CaddyConfig
    const srv0 = typed.apps?.http?.servers?.srv0
    if (srv0 === undefined || typeof srv0 !== "object" || srv0 === null || !Array.isArray(srv0.routes)) {
      return createResultError(op, "dev lease reconcile server configuration is invalid")
    }
    return createResult({
      ...typed,
      apps: {
        ...typed.apps,
        http: {
          ...typed.apps?.http,
          servers: {
            ...typed.apps?.http?.servers,
            srv0: { ...srv0, routes: [...srv0.routes, ...active.map(leaseRoute)] },
          },
        },
      },
    })
  })
}
