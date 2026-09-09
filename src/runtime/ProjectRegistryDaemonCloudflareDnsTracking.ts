import type { PromiseResult } from "#result"
import type { ProjectRegistryDaemonCloudflareDnsTrackingState } from "./ProjectRegistryDaemonCloudflareDnsTrackingState.js"

export type ProjectRegistryDaemonCloudflareDnsTracking = {
  read(): PromiseResult<ProjectRegistryDaemonCloudflareDnsTrackingState>
  write(state: ProjectRegistryDaemonCloudflareDnsTrackingState): PromiseResult<void>
}
