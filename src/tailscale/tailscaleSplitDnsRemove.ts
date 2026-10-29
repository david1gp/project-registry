import * as a from "valibot"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { TailscaleSplitDnsAuth } from "./TailscaleSplitDnsAuth.js"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsErrorDataCreate } from "./tailscaleSplitDnsErrorDataCreate.js"
import { tailscaleSplitDnsRemovePlanCreate } from "./tailscaleSplitDnsRemovePlanCreate.js"
import {
  tailscaleSplitDnsAuthValidate,
  tailscaleSplitDnsMapGet,
  tailscaleSplitDnsMapPatch,
} from "./tailscaleSplitDnsRequest.js"
import { tailscaleSplitDnsStateSchema } from "./tailscaleSplitDnsStateSchema.js"

/**
 * GET the map, verify owned hostnames, record priors, PATCH {host: null},
 * reread and confirm absence. Refuses entries that drifted or are
 * foreign-owned; unrelated entries are never touched.
 */
export async function tailscaleSplitDnsRemove(options: {
  auth: TailscaleSplitDnsAuth
  hostnames: readonly string[]
  nodeAddress: string
  stateFile: string
  stateWrite: (path: string, content: string) => Promise<void>
  fetch?: TailscaleSplitDnsFetch
  signal?: AbortSignal
}): PromiseResult<{ removed: string[]; alreadyAbsent: string[]; stateFile: string }> {
  const op = "tailscaleSplitDnsRemove"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Split-DNS remove options are required")
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
  const planR = tailscaleSplitDnsRemovePlanCreate(currentR.data, options.hostnames, options.nodeAddress)
  if (!planR.success) {
    return createResultError(op, planR.errorMessage, tailscaleSplitDnsErrorDataCreate({ operation: "split-dns-plan" }))
  }
  if (Object.keys(planR.data.toRemove).length === 0) {
    return createResult({ removed: [], alreadyAbsent: planR.data.alreadyAbsent, stateFile: options.stateFile })
  }
  const prior: Record<string, string[] | null> = {}
  for (const hostname of Object.keys(planR.data.toRemove)) {
    prior[hostname] = currentR.data[hostname] ?? null
  }
  const stateParsed = a.safeParse(tailscaleSplitDnsStateSchema, {
    version: 1,
    tailnet: options.auth.tailnet.trim(),
    nodeAddress: options.nodeAddress,
    savedAt: new Date().toISOString(),
    prior,
    applied: Object.fromEntries(Object.keys(planR.data.toRemove).map((hostname) => [hostname, null])),
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
  const patchedR = await tailscaleSplitDnsMapPatch({
    op,
    endpoint: endpointR.data,
    body: planR.data.toRemove,
    fetch: fetcher,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!patchedR.success) return patchedR
  const rereadR = await tailscaleSplitDnsMapGet({
    op,
    endpoint: endpointR.data,
    fetch: fetcher,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!rereadR.success) return rereadR
  for (const hostname of Object.keys(planR.data.toRemove)) {
    if (rereadR.data[hostname] !== undefined) {
      return createResultError(
        op,
        `Split-DNS removal not reflected for ${hostname}; refusing to record success`,
        tailscaleSplitDnsErrorDataCreate({ operation: "split-dns-verify" }),
      )
    }
  }
  return createResult({
    removed: Object.keys(planR.data.toRemove),
    alreadyAbsent: planR.data.alreadyAbsent,
    stateFile: options.stateFile,
  })
}
