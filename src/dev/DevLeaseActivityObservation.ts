/**
 * One observed request for a dev-lease hostname, read from the shared
 * dev-lease Caddy access log. `seenAt` is a millisecond epoch timestamp
 * derived from the log record's `ts` field and clamped to the reconcile
 * clock by the reader, so a stale or skewed record can never extend a lease
 * past the tick that observed it.
 */
export type DevLeaseActivityObservation = {
  host: string
  seenAt: number
}
