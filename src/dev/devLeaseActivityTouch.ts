import type { DevLeaseActivityObservation } from "./DevLeaseActivityObservation.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"

/**
 * Pure idle-touch: fold observed `(host, seenAt)` pairs into active leases.
 * A lease advances only to a `seenAt` newer than its `lastSeenAt` (already
 * clamped to `now` by the reader), so replayed or skewed records can never
 * move a lease backwards or fabricate activity. Non-active leases have no
 * route and therefore no traffic; they are never touched.
 */
export function devLeaseActivityTouch(options: {
  leases: readonly DevLeaseRecord[]
  observations: readonly DevLeaseActivityObservation[]
  now: number
}): { leases: DevLeaseRecord[]; touched: number } {
  const latest = new Map<string, number>()
  for (const observation of options.observations) {
    if (typeof observation.host !== "string" || observation.host.length === 0) continue
    if (!Number.isFinite(observation.seenAt)) continue
    const seenAt = Math.min(Math.floor(observation.seenAt), options.now)
    if (!Number.isSafeInteger(seenAt) || seenAt < 0) continue
    const known = latest.get(observation.host)
    if (known === undefined || seenAt > known) latest.set(observation.host, seenAt)
  }

  let touched = 0
  const leases = options.leases.map((lease) => {
    if (lease.state !== "active") return lease
    const seenAt = latest.get(lease.hostname)
    if (seenAt === undefined || seenAt <= lease.lastSeenAt) return lease
    touched += 1
    return { ...lease, lastSeenAt: seenAt }
  })
  return { leases, touched }
}
