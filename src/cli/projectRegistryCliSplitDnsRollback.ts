import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { TailscaleSplitDnsAuth } from "../tailscale/TailscaleSplitDnsAuth.js"
import type { TailscaleSplitDnsFetch } from "../tailscale/TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsRollback } from "../tailscale/tailscaleSplitDnsRollback.js"

const tailscaleApiBaseUrlDefault = "https://api.tailscale.com/api/v2"

export type ProjectRegistryCliSplitDnsRollbackResult = {
  stateFile: string
  restored: string[]
}

function ownerFileName(owner: string): string | undefined {
  if (
    owner.length === 0 ||
    owner === "." ||
    owner === ".." ||
    owner.includes("/") ||
    owner.includes("\\") ||
    owner.includes("\0")
  ) {
    return undefined
  }
  return `${owner}.split-dns.json`
}

/**
 * Restore owned split-DNS entries from a per-owner state file. This is a
 * local admin command (no daemon round-trip): it reads the state file the
 * reconciler wrote before its last PATCH, resolves Tailscale auth from the
 * environment, and restores via PATCH only — refusing on tailnet mismatch
 * or when an owned entry changed externally since apply. Credentials are
 * read, never logged or printed.
 */
export async function projectRegistryCliSplitDnsRollback(options: {
  owner?: string
  stateFile?: string
  stateDir?: string
  environment?: Readonly<Record<string, string | undefined>>
  stateRead?: (path: string) => Promise<string>
  fetch?: TailscaleSplitDnsFetch
}): PromiseResult<ProjectRegistryCliSplitDnsRollbackResult> {
  const op = "projectRegistryCliSplitDnsRollback"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Split-DNS rollback options are required")
  }
  const environment = options.environment ?? {}
  if (typeof environment !== "object" || environment === null) {
    return createResultError(op, "Split-DNS rollback environment is invalid")
  }
  if (options.stateRead !== undefined && typeof options.stateRead !== "function") {
    return createResultError(op, "Split-DNS rollback state reader is invalid")
  }

  let stateFile: string | undefined
  if (options.stateFile !== undefined) {
    if (typeof options.stateFile !== "string" || options.stateFile.length === 0) {
      return createResultError(op, "Option --state-file requires a path.")
    }
    if (options.owner !== undefined || options.stateDir !== undefined) {
      return createResultError(op, "Options --state-file and --owner/--state-dir cannot be combined.")
    }
    stateFile = options.stateFile
  } else {
    if (typeof options.owner !== "string" || typeof options.stateDir !== "string") {
      return createResultError(op, "Option --state-file or both --owner and --state-dir are required.")
    }
    const filename = ownerFileName(options.owner)
    if (filename === undefined) {
      return createResultError(op, "Split-DNS rollback owner is invalid")
    }
    if (options.stateDir.length === 0 || options.stateDir.includes("\0")) {
      return createResultError(op, "Option --state-dir requires a directory.")
    }
    stateFile = join(options.stateDir, filename)
  }
  if (stateFile.includes("\0")) {
    return createResultError(op, "Split-DNS rollback state file is invalid")
  }

  const tailnet = (environment.TAILSCALE_TAILNET ?? "").trim()
  if (tailnet.length === 0) {
    return createResultError(op, "TAILSCALE_TAILNET is required (the tailnet scope to restore).")
  }
  const apiKey = (environment.TAILSCALE_API_KEY ?? environment.TAILSCALE_ACCESS_TOKEN ?? "").trim()
  if (apiKey.length === 0 || /\s/.test(apiKey)) {
    return createResultError(op, "TAILSCALE_API_KEY (or TAILSCALE_ACCESS_TOKEN) is required.")
  }
  const baseUrl = (environment.TAILSCALE_API_BASE ?? tailscaleApiBaseUrlDefault).trim().replace(/\/+$/, "")
  if (baseUrl.length === 0) {
    return createResultError(op, "TAILSCALE_API_BASE must not be blank.")
  }
  const auth: TailscaleSplitDnsAuth = { tailnet, apiKey, baseUrl }

  const stateRead = options.stateRead ?? ((path: string) => readFile(path, "utf8"))
  const rolledBack = await tailscaleSplitDnsRollback({
    auth,
    stateFile,
    stateRead,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  if (!rolledBack.success) return rolledBack
  return createResult({ stateFile, restored: rolledBack.data.restored })
}
