import * as a from "valibot"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { TailscaleSplitDnsAuth } from "./TailscaleSplitDnsAuth.js"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsErrorDataCreate } from "./tailscaleSplitDnsErrorDataCreate.js"
import {
  tailscaleSplitDnsAuthValidate,
  tailscaleSplitDnsMapGet,
  tailscaleSplitDnsMapPatch,
} from "./tailscaleSplitDnsRequest.js"
import { tailscaleSplitDnsStateSchema } from "./tailscaleSplitDnsStateSchema.js"

function valueEqual(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
  if (left === null || left === undefined) return right === null || right === undefined
  if (right === null || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((entry, index) => entry === right[index])
}

/**
 * Restore prior owned entries via PATCH only. Refuses to clobber an owned
 * FQDN whose live value no longer matches what apply/remove recorded
 * (concurrent change), and refuses state recorded for another tailnet.
 */
export async function tailscaleSplitDnsRollback(options: {
  auth: TailscaleSplitDnsAuth
  stateFile: string
  stateRead: (path: string) => Promise<string>
  fetch?: TailscaleSplitDnsFetch
  signal?: AbortSignal
}): PromiseResult<{ restored: string[] }> {
  const op = "tailscaleSplitDnsRollback"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Split-DNS rollback options are required")
  }
  if (typeof options.stateFile !== "string" || options.stateFile.trim() === "") {
    return createResultError(op, "A state file path is required to restore prior owned entries")
  }
  if (typeof options.stateRead !== "function") {
    return createResultError(op, "Split-DNS state reader is required")
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
  const signal = options.signal

  let raw: string
  try {
    raw = await options.stateRead(options.stateFile)
  } catch {
    return createResultError(
      op,
      "Split-DNS rollback state could not be read",
      tailscaleSplitDnsErrorDataCreate({ operation: "state-read" }),
    )
  }
  let stateJson: unknown
  try {
    stateJson = JSON.parse(raw)
  } catch {
    return createResultError(
      op,
      "Split-DNS rollback state is not JSON",
      tailscaleSplitDnsErrorDataCreate({ operation: "state-read" }),
    )
  }
  const stateR = a.safeParse(tailscaleSplitDnsStateSchema, stateJson)
  if (!stateR.success) {
    return createResultError(
      op,
      a.summarize(stateR.issues),
      tailscaleSplitDnsErrorDataCreate({ operation: "state-read" }),
    )
  }
  if (stateR.output.tailnet !== options.auth.tailnet.trim()) {
    return createResultError(
      op,
      "Split-DNS rollback state is for another tailnet; refusing",
      tailscaleSplitDnsErrorDataCreate({ operation: "state-read" }),
    )
  }
  const currentR = await tailscaleSplitDnsMapGet({
    op,
    endpoint: endpointR.data,
    fetch: fetcher,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!currentR.success) return currentR
  for (const hostname of Object.keys(stateR.output.applied)) {
    const live = currentR.data[hostname] ?? null
    const applied = stateR.output.applied[hostname] ?? null
    if (!valueEqual(live, applied ?? undefined)) {
      return createResultError(
        op,
        `Split-DNS entry ${hostname} changed externally since apply; refusing to clobber`,
        tailscaleSplitDnsErrorDataCreate({ operation: "split-dns-verify" }),
      )
    }
  }
  const restore: Record<string, string[] | null> = {}
  for (const hostname of Object.keys(stateR.output.applied)) {
    restore[hostname] = stateR.output.prior[hostname] ?? null
  }
  if (Object.keys(restore).length === 0) return createResult({ restored: [] })
  const patchedR = await tailscaleSplitDnsMapPatch({
    op,
    endpoint: endpointR.data,
    body: restore,
    fetch: fetcher,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!patchedR.success) return patchedR
  return createResult({ restored: Object.keys(restore) })
}
