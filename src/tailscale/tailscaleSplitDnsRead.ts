import { createResultError, type PromiseResult } from "#result"
import type { TailscaleSplitDnsAuth } from "./TailscaleSplitDnsAuth.js"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import type { TailscaleSplitDnsMap } from "./tailscaleSplitDnsMapSchema.js"
import { tailscaleSplitDnsAuthValidate, tailscaleSplitDnsMapGet } from "./tailscaleSplitDnsRequest.js"

/** Read-only GET of the tailnet split-DNS map; never logs or returns the token. */
export async function tailscaleSplitDnsRead(options: {
  auth: TailscaleSplitDnsAuth
  fetch?: TailscaleSplitDnsFetch
  signal?: AbortSignal
}): PromiseResult<TailscaleSplitDnsMap> {
  const op = "tailscaleSplitDnsRead"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Split-DNS read options are required")
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    return createResultError(op, "Split-DNS fetch is invalid")
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    return createResultError(op, "Split-DNS cancellation signal is invalid")
  }
  const endpointR = tailscaleSplitDnsAuthValidate(options.auth, op)
  if (!endpointR.success) return endpointR
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== "function") return createResultError(op, "Split-DNS fetch is unavailable")
  return tailscaleSplitDnsMapGet({
    op,
    endpoint: endpointR.data,
    fetch: fetcher,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}
