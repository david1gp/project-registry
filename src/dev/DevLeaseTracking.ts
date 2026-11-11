import type { PromiseResult } from "#result"
import type { DevLeaseTrackingState } from "./devLeaseTrackingState.js"

export type DevLeaseTracking = {
  read(): PromiseResult<DevLeaseTrackingState>
  write(state: DevLeaseTrackingState): PromiseResult<void>
}
