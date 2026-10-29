import * as a from "valibot"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { TailscaleSplitDnsAuth } from "./TailscaleSplitDnsAuth.js"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsErrorDataCreate } from "./tailscaleSplitDnsErrorDataCreate.js"
import { tailscaleSplitDnsPlanCreate } from "./tailscaleSplitDnsPlanCreate.js"
import {
  tailscaleSplitDnsAuthValidate,
  tailscaleSplitDnsMapGet,
  tailscaleSplitDnsMapPatch,
} from "./tailscaleSplitDnsRequest.js"
import { tailscaleSplitDnsStateSchema } from "./tailscaleSplitDnsStateSchema.js"

/**
 * PATCH only owned exact private FQDNs; unrelated entries, global resolvers,
 * and MagicDNS stay untouched. Prior owned values are recorded to `stateFile`
 * (via the injected writer) before the PATCH so rollback can restore them.
 * Credentials are passed in and never logged.
 */
export async function tailscaleSplitDnsApply(options: {
  auth: TailscaleSplitDnsAuth
  hostnames: readonly string[]
  nodeAddress: string
  stateFile: string
  stateWrite: (path: string, content: string) => Promise<void>
  fetch?: TailscaleSplitDnsFetch
  signal?: AbortSignal
}): PromiseResult<{ applied: Record<string, string[]>; alreadyCurrent: string[]; stateFile: string }> {
  const op = "tailscaleSplitDnsApply"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Split-DNS apply options are required")
  }
  if (typeof options.stateFile !== "string" || options.stateFile.trim() === "") {
    return createResultError(op, "A state file path is required to record prior owned entries for rollback")
  }
  if (typeof options.stateWrite !== "function") {
    return createResultError(op, "Split-DNS state writer is required")
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

  const currentR = await tailscaleSplitDnsMapGet({
    op,
    endpoint: endpointR.data,
    fetch: fetcher,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!currentR.success) return currentR
  const planR = tailscaleSplitDnsPlanCreate(currentR.data, {
    hostnames: options.hostnames,
    nodeAddress: options.nodeAddress,
  })
  if (!planR.success) {
    return createResultError(op, planR.errorMessage, tailscaleSplitDnsErrorDataCreate({ operation: "split-dns-plan" }))
  }
  if (Object.keys(planR.data.toApply).length === 0) {
    return createResult({ applied: {}, alreadyCurrent: planR.data.unchanged, stateFile: options.stateFile })
  }
  const prior: Record<string, string[] | null> = {}
  for (const hostname of Object.keys(planR.data.toApply)) {
    const existing = currentR.data[hostname]
    prior[hostname] = Array.isArray(existing) ? existing : null
  }
  const stateParsed = a.safeParse(tailscaleSplitDnsStateSchema, {
    version: 1,
    tailnet: options.auth.tailnet.trim(),
    nodeAddress: planR.data.nodeAddress,
    savedAt: new Date().toISOString(),
    prior,
    applied: planR.data.toApply,
  })
  if (!stateParsed.success) {
    return createResultError(
      op,
      a.summarize(stateParsed.issues),
      tailscaleSplitDnsErrorDataCreate({ operation: "state-write" }),
    )
  }
  try {
    await options.stateWrite(options.stateFile, `${JSON.stringify(stateParsed.output, null, 2)}\n`)
  } catch {
    return createResultError(
      op,
      "Split-DNS rollback state could not be written",
      tailscaleSplitDnsErrorDataCreate({ operation: "state-write" }),
    )
  }
  const updatedR = await tailscaleSplitDnsMapPatch({
    op,
    endpoint: endpointR.data,
    body: planR.data.toApply,
    fetch: fetcher,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!updatedR.success) return updatedR
  for (const hostname of Object.keys(planR.data.toApply)) {
    const live = updatedR.data[hostname]
    if (!Array.isArray(live) || live.length !== 1 || live[0] !== planR.data.nodeAddress) {
      return createResultError(
        op,
        `Split-DNS update not reflected for ${hostname}; refusing to record success`,
        tailscaleSplitDnsErrorDataCreate({ operation: "split-dns-verify" }),
      )
    }
  }
  return createResult({
    applied: planR.data.toApply,
    alreadyCurrent: planR.data.unchanged,
    stateFile: options.stateFile,
  })
}
