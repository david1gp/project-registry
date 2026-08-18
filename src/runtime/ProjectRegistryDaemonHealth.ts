import type { ProjectRegistryDaemonState } from "./ProjectRegistryDaemonState.js"

export type ProjectRegistryDaemonHealth = {
  live: boolean
  state: ProjectRegistryDaemonState
}
