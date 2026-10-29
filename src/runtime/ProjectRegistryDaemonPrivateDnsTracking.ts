import type { PromiseResult } from "#result"
import type { ProjectRegistryDaemonPrivateDnsTrackingState } from "./ProjectRegistryDaemonPrivateDnsTrackingState.js"

export type ProjectRegistryDaemonPrivateDnsTracking = {
  read(): PromiseResult<ProjectRegistryDaemonPrivateDnsTrackingState>
  write(state: ProjectRegistryDaemonPrivateDnsTrackingState): PromiseResult<void>
}
