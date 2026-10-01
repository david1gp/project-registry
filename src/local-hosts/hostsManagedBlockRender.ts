import { createResult, createResultError, type Result } from "#result"

const startMarker = "# BEGIN project-registry managed hosts"
const endMarker = "# END project-registry managed hosts"

/** Render a stable managed hosts block for validated local domain names. */
export function hostsManagedBlockRender(domains: readonly string[]): Result<string> {
  const op = "hostsManagedBlockRender"
  const normalized: string[] = []

  for (const input of domains) {
    const domain = input.trim().toLowerCase().replace(/\.$/, "")
    if (
      domain.length === 0 ||
      domain.length > 253 ||
      domain.split(".").some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    ) {
      return createResultError(op, `Invalid hostname: ${input}`)
    }
    normalized.push(domain)
  }

  const entries = [...new Set(normalized)].sort().map((domain) => `127.0.0.1 ${domain}`)
  return createResult([startMarker, ...entries, endMarker, ""].join("\n"))
}
