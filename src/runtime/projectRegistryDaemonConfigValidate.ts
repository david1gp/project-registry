import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"
import { projectRegistryDaemonConfigSchema } from "./projectRegistryDaemonConfigSchema.js"

export function projectRegistryDaemonConfigValidate(input: unknown): Result<ProjectRegistryDaemonConfig> {
  const op = "projectRegistryDaemonConfigValidate"
  try {
    const parsed = a.safeParse(projectRegistryDaemonConfigSchema, input)
    if (!parsed.success) return createResultError(op, a.summarize(parsed.issues))

    let adminUrl: URL
    try {
      adminUrl = new URL(parsed.output.caddyAdminUrl)
    } catch {
      return createResultError(op, "caddy admin URL is invalid")
    }
    if (!["http:", "https:"].includes(adminUrl.protocol) || adminUrl.username !== "" || adminUrl.password !== "") {
      return createResultError(op, "caddy admin URL must be an HTTP URL without credentials")
    }

    if (parsed.output.portRange.from > parsed.output.portRange.to) {
      return createResultError(op, "port range start must not exceed its end")
    }

    return createResult({
      ...parsed.output,
      mappedUsers: [...parsed.output.mappedUsers],
      oidc:
        parsed.output.oidc === undefined
          ? undefined
          : { ...parsed.output.oidc, scope: parsed.output.oidc.scope?.slice() },
      portRange: { ...parsed.output.portRange },
      webListener: { ...parsed.output.webListener },
    })
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : "invalid daemon configuration")
  }
}
