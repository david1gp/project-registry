import { createResult, createResultError, type Result } from "#result"
import {
  projectPrivateTlsChallengeResolversDefault,
  projectPrivateTlsChallengeResolversValidate,
  projectPrivateTlsEnrollmentPlanCreate,
} from "./projectPrivateTlsEnrollment.js"
import { projectPrivateTlsTokenOwnerSelect } from "./projectPrivateTlsTokenSelect.js"

/**
 * Static owner-to-environment-variable bindings for private-Caddy DNS-01.
 * Each variable is defined by the private Caddy service EnvironmentFile
 * (root-only, `~/ds`-managed); the rendered Caddy JSON references it as
 * `{env.VAR}` so the token value is resolved server-side at runtime and
 * never appears in registry output, logs, or API payloads.
 *
 * `leo` keeps the default variable (it covers `wonder1.de`); `david`
 * uses the David-zones variable (it covers `david-siewert.com`).
 * `fabian`/`musa` are unbound until they join the tailnet: rendering
 * their enrollments fails closed, exactly like the "code change first"
 * rule for future zones in the owner-zone policy.
 */
export const projectPrivateTlsTokenEnvVarsDefault: Readonly<Record<string, string>> = {
  leo: "CLOUDFLARE_API_TOKEN",
  david: "CLOUDFLARE_API_TOKEN_DAVID_ZONES",
}

const tokenEnvVarPattern = /^[A-Z][A-Z0-9_]*$/

export type ProjectPrivateTlsAutomationIssuer = {
  module: "acme"
  challenges: {
    dns: {
      provider: { name: "cloudflare"; api_token: string }
      resolvers: string[]
    }
  }
}

export type ProjectPrivateTlsAutomationPolicy = {
  subjects: string[]
  issuers: ProjectPrivateTlsAutomationIssuer[]
}

export type ProjectPrivateTlsAutomationTls = {
  automation: { policies: ProjectPrivateTlsAutomationPolicy[] }
  certificates: { automate: string[] }
}

export type ProjectPrivateTlsAutomationRender = {
  /** The `apps.tls` section to install on the private Caddy. */
  tls: ProjectPrivateTlsAutomationTls
  /** Multi-level hostnames with their own per-host DNS-01 enrollment. */
  enrolled: string[]
  /** Single-level hostnames left to the zone wildcard (no per-host policy). */
  wildcardCovered: string[]
}

export type ProjectPrivateTlsAutomationClaim = {
  owner: unknown
  hostnames: unknown
}

function claimsValidate(claims: unknown, op: string): Result<ProjectPrivateTlsAutomationClaim[]> {
  if (!Array.isArray(claims)) return createResultError(op, "private TLS automation claims are required")
  for (const claim of claims) {
    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
      return createResultError(op, "private TLS automation claims must be objects")
    }
  }
  return createResult(claims as ProjectPrivateTlsAutomationClaim[])
}

function tokenEnvVarsValidate(tokenEnvVars: unknown, op: string): Result<Readonly<Record<string, string>>> {
  if (tokenEnvVars === undefined) return createResult(projectPrivateTlsTokenEnvVarsDefault)
  if (typeof tokenEnvVars !== "object" || tokenEnvVars === null || Array.isArray(tokenEnvVars)) {
    return createResultError(op, "private TLS token environment bindings are invalid")
  }
  for (const [owner, envVar] of Object.entries(tokenEnvVars)) {
    if (typeof envVar !== "string" || !tokenEnvVarPattern.test(envVar)) {
      return createResultError(op, `private TLS token environment variable for owner "${owner}" is invalid`)
    }
  }
  return createResult(tokenEnvVars as Readonly<Record<string, string>>)
}

/**
 * Render the private-Caddy TLS enrollment set into an `apps.tls` section:
 * per-credential DNS-01 issuer policies (zones sharing one credential
 * share one policy) plus the `certificates.automate` loader that enrolls
 * certificates on the zero-route baseline, before any route exists.
 *
 * Mirrors the `~/ds` `leoBatchTlsPrepare` enrollment shape: exact-host
 * subjects only (never widened to zones), ACME DNS-01 with a Cloudflare
 * `{env.*}` placeholder (never a token literal), and public challenge
 * resolvers rendered as `IP:53`. Single-level names are wildcard-covered
 * and produce no per-host policy; cross-zone, apex, and wildcard inputs
 * are rejected, never rendered. Emits no logs; takes no token values.
 */
export function projectPrivateTlsAutomationRender(options: {
  claims: unknown
  tokenEnvVars?: unknown
  resolvers?: unknown
  privateAddresses?: readonly unknown[]
  op?: string
}): Result<ProjectPrivateTlsAutomationRender> {
  const op = options?.op ?? "projectPrivateTlsAutomationRender"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "private TLS automation options are required")
  }
  const claimsR = claimsValidate(options.claims, op)
  if (!claimsR.success) return claimsR
  const envVarsR = tokenEnvVarsValidate(options.tokenEnvVars, op)
  if (!envVarsR.success) return envVarsR
  const resolversR = projectPrivateTlsChallengeResolversValidate(
    options.resolvers ?? [...projectPrivateTlsChallengeResolversDefault],
    { ...(options.privateAddresses === undefined ? {} : { privateAddresses: options.privateAddresses }), op },
  )
  if (!resolversR.success) return resolversR

  const enrolledOwner = new Map<string, string>()
  const wildcardCovered = new Set<string>()
  for (const claim of claimsR.data) {
    const planR = projectPrivateTlsEnrollmentPlanCreate(claim.owner, claim.hostnames, op)
    if (!planR.success) return planR
    for (const hostname of planR.data.wildcardCovered) wildcardCovered.add(hostname)
    for (const hostname of planR.data.enroll) {
      const previous = enrolledOwner.get(hostname)
      if (previous !== undefined && previous !== planR.data.owner) {
        return createResultError(
          op,
          `private hostname "${hostname}" is claimed for TLS by owners "${previous}" and "${planR.data.owner}"; refusing to render`,
        )
      }
      enrolledOwner.set(hostname, planR.data.owner)
    }
  }
  for (const hostname of enrolledOwner.keys()) wildcardCovered.delete(hostname)

  const subjectsByEnvVar = new Map<string, string[]>()
  for (const [hostname, owner] of enrolledOwner) {
    const selectionR = projectPrivateTlsTokenOwnerSelect(owner, hostname, op)
    if (!selectionR.success) return selectionR
    const envVar = envVarsR.data[selectionR.data.owner]
    if (envVar === undefined) {
      return createResultError(
        op,
        `private TLS has no token environment binding for owner "${selectionR.data.owner}"; refusing to render enrollment for "${hostname}"`,
      )
    }
    const subjects = subjectsByEnvVar.get(envVar) ?? []
    subjects.push(hostname)
    subjectsByEnvVar.set(envVar, subjects)
  }

  const resolvers = resolversR.data.map((resolver) => `${resolver}:53`)
  const policies: ProjectPrivateTlsAutomationPolicy[] = [...subjectsByEnvVar]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([envVar, subjects]) => ({
      subjects: [...subjects].sort(),
      issuers: [
        {
          module: "acme",
          challenges: {
            dns: {
              provider: { name: "cloudflare", api_token: `{env.${envVar}}` },
              resolvers: [...resolvers],
            },
          },
        },
      ],
    }))
  const enrolled = [...enrolledOwner.keys()].sort()
  return createResult({
    tls: { automation: { policies }, certificates: { automate: [...enrolled] } },
    enrolled,
    wildcardCovered: [...wildcardCovered].sort(),
  })
}
