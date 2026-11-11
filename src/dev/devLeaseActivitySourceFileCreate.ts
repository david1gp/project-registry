import { createResult, createResultError, type Result } from "#result"
import { projectAccessLogParser } from "../access-log/projectAccessLogParser.js"
import type { DevLeaseActivityFilesystem } from "./DevLeaseActivityFilesystem.js"
import type { DevLeaseActivityObservation } from "./DevLeaseActivityObservation.js"
import type { DevLeaseActivitySource } from "./DevLeaseActivitySource.js"

const defaultMaxTailBytes = 64 * 1024
const maximumMaxTailBytes = 1024 * 1024

export type DevLeaseActivitySourceFileCreateOptions = {
  path: string
  filesystem: DevLeaseActivityFilesystem
  clock?: () => number
  maxTailBytes?: number
}

function observationOf(record: unknown, now: number): DevLeaseActivityObservation | undefined {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined
  const request = (record as Record<string, unknown>).request
  if (typeof request !== "object" || request === null || Array.isArray(request)) return undefined
  const host = (request as Record<string, unknown>).host
  if (typeof host !== "string" || host.length === 0) return undefined
  const ts = (record as Record<string, unknown>).ts
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) return undefined
  // Caddy access-log `ts` is epoch seconds; the touch only moves forward, so
  // clamp skewed future records to the reconcile clock instead of dropping them.
  const seenAt = Math.min(Math.floor(ts * 1000), now)
  if (!Number.isSafeInteger(seenAt) || seenAt < 0) return undefined
  return { host, seenAt }
}

/**
 * File-tail activity source over the shared dev-lease Caddy access log.
 * Reads the last `maxTailBytes` each tick and returns the newest `seenAt`
 * per requested host. Total by contract: a missing, empty, unreadable, or
 * fully malformed log yields zero observations — absence of signal never
 * extends a lease, and a broken reader degrades to TTL expiry.
 */
export function devLeaseActivitySourceFileCreate(
  options: DevLeaseActivitySourceFileCreateOptions,
): Result<DevLeaseActivitySource> {
  const op = "devLeaseActivitySourceFileCreate"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "dev lease activity source options are required")
  }
  const { path, filesystem } = options
  if (typeof path !== "string" || path.length === 0) {
    return createResultError(op, "dev lease activity log path is required")
  }
  if (typeof filesystem !== "object" || filesystem === null || typeof filesystem.readTail !== "function") {
    return createResultError(op, "dev lease activity filesystem is invalid")
  }
  const clock = options.clock ?? Date.now
  if (typeof clock !== "function") return createResultError(op, "dev lease activity clock is invalid")
  const maxTailBytes = options.maxTailBytes ?? defaultMaxTailBytes
  if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 1 || maxTailBytes > maximumMaxTailBytes) {
    return createResultError(op, "dev lease activity tail size is invalid")
  }

  return createResult({
    async hostsCurrent() {
      let now: number
      try {
        now = clock()
      } catch {
        return []
      }
      if (!Number.isSafeInteger(now) || now < 0) return []
      let tail: Uint8Array | undefined
      try {
        tail = await filesystem.readTail(path, maxTailBytes)
      } catch {
        return []
      }
      if (tail === undefined || tail.length === 0) return []
      // A tail cut mid-line leaves a fragment that cannot parse as JSON, so
      // every line is attempted and fragments are skipped, never faked.
      const latest = new Map<string, number>()
      for (const line of new TextDecoder().decode(tail).split("\n")) {
        if (line.trim() === "") continue
        const parsed = projectAccessLogParser(line)
        if (!parsed.success) continue
        const observation = observationOf(parsed.data, now)
        if (observation === undefined) continue
        const known = latest.get(observation.host)
        if (known === undefined || observation.seenAt > known) latest.set(observation.host, observation.seenAt)
      }
      return [...latest].map(([host, seenAt]) => ({ host, seenAt }))
    },
  })
}
