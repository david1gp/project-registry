import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectAccessLogRootValidate } from "../access-log/projectAccessLogRootValidate.js"
import { projectDomainValidate } from "../project/projectDomainValidate.js"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"
import { projectRegistryDaemonConfigSchema } from "./projectRegistryDaemonConfigSchema.js"

function defaultUserDomainsNormalize(domains: Readonly<Record<string, string>>): Result<Record<string, string>> {
  const op = "projectRegistryDaemonConfigValidate"
  const normalized: Record<string, string> = {}
  for (const [username, value] of Object.entries(domains)) {
    const domainR = projectDomainValidate(value, op)
    if (!domainR.success) {
      return createResultError(op, `default domain for ${username} is invalid`)
    }
    normalized[username] = domainR.data
  }
  return createResult(normalized)
}

export function projectRegistryDaemonConfigValidate(input: unknown): Result<ProjectRegistryDaemonConfig> {
  const op = "projectRegistryDaemonConfigValidate"
  try {
    const parsed = a.safeParse(projectRegistryDaemonConfigSchema, input)
    if (!parsed.success) return createResultError(op, a.summarize(parsed.issues))

    const defaultUserDomainsR = defaultUserDomainsNormalize(parsed.output.defaultUserDomains)
    if (!defaultUserDomainsR.success) return defaultUserDomainsR

    if (
      parsed.output.oidc !== undefined &&
      parsed.output.zitadel !== undefined &&
      parsed.output.oidc.issuer !== parsed.output.zitadel.issuer
    ) {
      return createResultError(op, "OIDC and Zitadel identity issuers must match")
    }

    if ((parsed.output.caddyUser === undefined) !== (parsed.output.caddyGroup === undefined)) {
      return createResultError(op, "Caddy service User and Group must be configured together")
    }

    let adminUrl: URL
    try {
      adminUrl = new URL(parsed.output.caddyAdminUrl)
    } catch {
      return createResultError(op, "caddy admin URL is invalid")
    }
    const adminHostname =
      adminUrl.hostname.startsWith("[") && adminUrl.hostname.endsWith("]")
        ? adminUrl.hostname.slice(1, -1)
        : adminUrl.hostname
    if (
      !["http:", "https:"].includes(adminUrl.protocol) ||
      !["localhost", "127.0.0.1", "::1"].includes(adminHostname) ||
      adminUrl.username !== "" ||
      adminUrl.password !== ""
    ) {
      return createResultError(op, "caddy admin URL must be an HTTP(S) loopback URL without credentials")
    }

    if (parsed.output.portRange.from > parsed.output.portRange.to) {
      return createResultError(op, "port range start must not exceed its end")
    }

    if (parsed.output.caddyAccessLogRoot !== undefined) {
      const accessLogRootR = projectAccessLogRootValidate(
        parsed.output.caddyAccessLogRoot,
        parsed.output.repositoryPath,
      )
      if (!accessLogRootR.success) return createResultError(op, accessLogRootR.errorMessage)
    }

    return createResult({
      ...parsed.output,
      mappedUsers: [...parsed.output.mappedUsers],
      defaultUserDomains: { ...defaultUserDomainsR.data },
      oidc:
        parsed.output.oidc === undefined
          ? undefined
          : { ...parsed.output.oidc, scope: parsed.output.oidc.scope?.slice() },
      zitadel: parsed.output.zitadel === undefined ? undefined : { ...parsed.output.zitadel },
      session: { ...parsed.output.session },
      portRange: { ...parsed.output.portRange },
      webListener: { ...parsed.output.webListener },
    })
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : "invalid daemon configuration")
  }
}
