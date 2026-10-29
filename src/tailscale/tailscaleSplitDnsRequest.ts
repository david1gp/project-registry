import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result, type ResultErr } from "#result"
import type { TailscaleSplitDnsAuth } from "./TailscaleSplitDnsAuth.js"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsErrorDataCreate } from "./tailscaleSplitDnsErrorDataCreate.js"
import { type TailscaleSplitDnsMap, tailscaleSplitDnsMapSchema } from "./tailscaleSplitDnsMapSchema.js"
import type { TailscaleSplitDnsOperation } from "./tailscaleSplitDnsOperationSchema.js"

export type TailscaleSplitDnsEndpoint = {
  url: string
  headers: Record<string, string>
}

function failureCreate(op: string, operation: TailscaleSplitDnsOperation, message: string, status?: number): ResultErr {
  const error = createResultError(op, message, tailscaleSplitDnsErrorDataCreate({ operation, statusCode: status }))
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    error.statusCode = status
  }
  return error
}

function httpMessageFor(status: number): string {
  if (status === 401) return "Tailscale API key is invalid or expired (status 401)"
  if (status === 403) return "Tailscale API key lacks admin scope for DNS (status 403)"
  if (status === 429) return "Tailscale API rate limit exceeded; retry later (status 429)"
  return `Split-DNS request failed (status ${status})`
}

function responseIsValid(response: unknown): response is Response {
  if (typeof response !== "object" || response === null) return false
  const candidate = response as { ok?: unknown; status?: unknown; json?: unknown }
  return (
    typeof candidate.ok === "boolean" &&
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 100 &&
    candidate.status <= 599 &&
    candidate.ok === (candidate.status >= 200 && candidate.status < 300) &&
    typeof candidate.json === "function"
  )
}

/**
 * Validate split-DNS credentials passed in by the caller. The API key is
 * accepted only as an opaque non-blank token and is never included in any
 * message, error data, or log line produced by this module.
 */
export function tailscaleSplitDnsAuthValidate(auth: unknown, op: string): Result<TailscaleSplitDnsEndpoint> {
  if (typeof auth !== "object" || auth === null) {
    return createResultError(op, "Split-DNS credentials are required")
  }
  const candidate = auth as Partial<TailscaleSplitDnsAuth>
  if (typeof candidate.tailnet !== "string" || candidate.tailnet.trim() === "") {
    return createResultError(op, "Split-DNS tailnet is required")
  }
  if (
    typeof candidate.apiKey !== "string" ||
    candidate.apiKey.length === 0 ||
    candidate.apiKey.trim() !== candidate.apiKey ||
    /\s/.test(candidate.apiKey)
  ) {
    return createResultError(op, "Split-DNS API key is invalid")
  }
  if (typeof candidate.baseUrl !== "string") {
    return createResultError(op, "Split-DNS API URL is invalid")
  }
  let base: URL
  try {
    base = new URL(candidate.baseUrl)
  } catch {
    return createResultError(op, "Split-DNS API URL is invalid")
  }
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    return createResultError(op, "Split-DNS API URL is invalid")
  }
  base.pathname = base.pathname.replace(/\/+$/, "")
  return createResult({
    url: `${base.origin}${base.pathname}/tailnet/${encodeURIComponent(candidate.tailnet.trim())}/dns/split-dns`,
    headers: { accept: "application/json", authorization: `Bearer ${candidate.apiKey}` },
  })
}

async function mapResponseParse(
  op: string,
  response: Response,
  operation: TailscaleSplitDnsOperation,
): Promise<Result<TailscaleSplitDnsMap>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return failureCreate(op, operation, "Split-DNS response is not JSON", response.status)
  }
  if (!response.ok) return failureCreate(op, operation, httpMessageFor(response.status), response.status)
  const parsed = a.safeParse(tailscaleSplitDnsMapSchema, body)
  if (!parsed.success) return failureCreate(op, operation, "Split-DNS response has an invalid map", response.status)
  return createResult(parsed.output)
}

/** Read-only GET of the tailnet split-DNS map; never logs or returns the token. */
export async function tailscaleSplitDnsMapGet(options: {
  op: string
  endpoint: TailscaleSplitDnsEndpoint
  fetch: TailscaleSplitDnsFetch
  signal?: AbortSignal
}): PromiseResult<TailscaleSplitDnsMap> {
  const op = options.op
  if (options.signal?.aborted) {
    return failureCreate(op, "split-dns-read", "Split-DNS reconciliation cancelled")
  }
  let response: Response
  try {
    response = await options.fetch(
      options.endpoint.url,
      options.signal === undefined
        ? { headers: options.endpoint.headers }
        : { headers: options.endpoint.headers, signal: options.signal },
    )
  } catch {
    if (options.signal?.aborted) return failureCreate(op, "split-dns-read", "Split-DNS reconciliation cancelled")
    return failureCreate(op, "request", "Split-DNS read request failed")
  }
  if (!responseIsValid(response)) return failureCreate(op, "request", "Split-DNS read request failed")
  return mapResponseParse(op, response, "split-dns-read")
}

/**
 * PATCH a merge of owned exact FQDNs only (`null` clears a domain). Callers
 * must only pass entries from the pure plan modules; this never issues PUT.
 */
export async function tailscaleSplitDnsMapPatch(options: {
  op: string
  endpoint: TailscaleSplitDnsEndpoint
  body: Record<string, string[] | null>
  fetch: TailscaleSplitDnsFetch
  signal?: AbortSignal
}): PromiseResult<TailscaleSplitDnsMap> {
  const op = options.op
  if (options.signal?.aborted) {
    return failureCreate(op, "split-dns-patch", "Split-DNS reconciliation cancelled")
  }
  let response: Response
  try {
    response = await options.fetch(
      options.endpoint.url,
      options.signal === undefined
        ? {
            method: "PATCH",
            headers: { ...options.endpoint.headers, "content-type": "application/json" },
            body: JSON.stringify(options.body),
          }
        : {
            method: "PATCH",
            headers: { ...options.endpoint.headers, "content-type": "application/json" },
            body: JSON.stringify(options.body),
            signal: options.signal,
          },
    )
  } catch {
    if (options.signal?.aborted) return failureCreate(op, "split-dns-patch", "Split-DNS reconciliation cancelled")
    return failureCreate(op, "request", "Split-DNS update request failed")
  }
  if (!responseIsValid(response)) return failureCreate(op, "request", "Split-DNS update request failed")
  return mapResponseParse(op, response, "split-dns-patch")
}
