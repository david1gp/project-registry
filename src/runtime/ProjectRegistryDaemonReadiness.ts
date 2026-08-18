import type { ProjectRegistryDaemonState } from "./ProjectRegistryDaemonState.js"

export type ProjectRegistryDaemonReadiness = {
  ready: boolean
  state: ProjectRegistryDaemonState
  repositoryReady: boolean
  listenersReady: boolean
  socketsReady: boolean
  caddyReady: boolean
  reason?: string
}
