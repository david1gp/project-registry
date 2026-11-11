import type { DevLeaseActivityObservation } from "./DevLeaseActivityObservation.js"

/**
 * Idle-touch signal for dev leases (named gap DEV-HTTP-ACTIVITY). The
 * production source tails the shared dev-lease Caddy access log; tests and
 * the dark path inject fakes or omit the source entirely. The contract is
 * total: a missing or unreadable log yields no observations (never an
 * error), so a broken reader degrades to TTL expiry instead of pinning
 * leases alive or disabling the reaper.
 */
export type DevLeaseActivitySource = {
  hostsCurrent(): Promise<readonly DevLeaseActivityObservation[]>
}
