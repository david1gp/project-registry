import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectSchema } from "../project/projectSchema.js"
import type { CaddyConfig } from "./CaddyConfig.js"
import type { CaddyConfigInspection } from "./CaddyConfigInspection.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import { caddyConfigSelect } from "./caddyConfigSelect.js"
import { caddyConfigSummary } from "./caddyConfigSummary.js"

function routesOf(config: CaddyConfig): unknown[] {
  return config.apps.http.servers.srv0.routes
}

function configWithRoutes(config: CaddyConfig, routes: unknown[]): CaddyConfig {
  return {
    ...config,
    apps: {
      ...config.apps,
      http: {
        ...config.apps.http,
        servers: {
          ...config.apps.http.servers,
          srv0: {
            ...config.apps.http.servers.srv0,
            routes,
          },
        },
      },
    },
  }
}

export function caddyConfigInspect(
  projects: unknown,
  options: unknown = {},
  selector?: unknown,
): Result<CaddyConfigInspection> {
  const op = "caddyConfigInspect"
  try {
    const parsed = a.safeParse(a.array(projectSchema), projects)
    if (!parsed.success) return createResultError(op, "visible project snapshot is invalid")

    const generated = caddyConfigGenerate(parsed.output, options)
    if (!generated.success) return createResultError(op, "Caddy configuration could not be generated")

    const summary = caddyConfigSummary(parsed.output)
    let config = generated.data
    let routes = routesOf(config)
    if (selector !== undefined && selector !== "") {
      if (typeof selector !== "string") return createResultError(op, "configuration selector is invalid")
      const selected = caddyConfigSelect(config, parsed.output, selector)
      if (!selected.success) return { ...selected, op }
      routes = selected.data
      config = configWithRoutes(config, routes)
    }

    return createResult({
      config,
      summary,
      routes: [...routes],
      projectCount: summary.length,
      routeCount: routes.length,
    })
  } catch {
    return createResultError(op, "Caddy inspection input is invalid")
  }
}
