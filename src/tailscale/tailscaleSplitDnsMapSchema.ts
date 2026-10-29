import * as a from "valibot"

/**
 * Exact Tailscale split-DNS contract: GET /tailnet/{tailnet}/dns/split-dns
 * returns a JSON map from domain to nameserver list. PATCH merges only the
 * supplied domains (value `null` clears a domain); PUT replaces everything
 * and must never be used. This schema validates GET/PATCH response bodies.
 */
export const tailscaleSplitDnsMapSchema = a.pipe(
  a.unknown(),
  a.check(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    "split-DNS map must be an object",
  ),
  a.record(a.string(), a.array(a.string())),
)

export type TailscaleSplitDnsMap = a.InferOutput<typeof tailscaleSplitDnsMapSchema>
