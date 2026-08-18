export type ProjectRegistryDaemonServer = {
  stop(options?: { closeActiveConnections?: boolean }): void | Promise<void>
}
