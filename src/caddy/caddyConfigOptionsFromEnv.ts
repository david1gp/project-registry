import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import type { CaddyConfigOptions } from "./caddyConfigOptionsSchema.js"
import { caddyConfigOptionsSchema } from "./caddyConfigOptionsSchema.js"

type Environment = Record<string, string | undefined>

function environmentValue(environment: Environment, name: string, legacyName: string): string | undefined {
  return environment[name] ?? environment[legacyName]
}

export function caddyConfigOptionsFromEnv(environment: unknown = Bun.env): Result<CaddyConfigOptions> {
  const op = "caddyConfigOptionsFromEnv"

  try {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      return createResultError(op, "invalid environment configuration")
    }

    const values = environment as Environment
    const issuer = environmentValue(values, "PROJECT_REGISTRY_OIDC_ISSUER", "CADDY_PROJECTS_OIDC_ISSUER")
    if (!issuer) {
      const defaults = a.safeParse(caddyConfigOptionsSchema, {})
      if (!defaults.success)
        return createResultError(op, `invalid Caddy configuration: ${a.summarize(defaults.issues)}`)
      return createResult(defaults.output)
    }

    const options = {
      oidc: {
        providerName:
          environmentValue(values, "PROJECT_REGISTRY_OIDC_PROVIDER", "CADDY_PROJECTS_OIDC_PROVIDER") ?? "zitadel",
        issuer,
        clientId: environmentValue(values, "PROJECT_REGISTRY_OIDC_CLIENT_ID", "CADDY_PROJECTS_OIDC_CLIENT_ID") ?? "",
        clientSecret:
          environmentValue(values, "PROJECT_REGISTRY_OIDC_CLIENT_SECRET", "CADDY_PROJECTS_OIDC_CLIENT_SECRET") ?? "",
        cookieSecret:
          environmentValue(values, "PROJECT_REGISTRY_OIDC_COOKIE_SECRET", "CADDY_PROJECTS_OIDC_COOKIE_SECRET") ?? "",
      },
    }
    const parsed = a.safeParse(caddyConfigOptionsSchema, options)
    if (!parsed.success) return createResultError(op, `invalid OIDC configuration: ${a.summarize(parsed.issues)}`)
    return createResult(parsed.output)
  } catch {
    return createResultError(op, "invalid environment configuration")
  }
}
