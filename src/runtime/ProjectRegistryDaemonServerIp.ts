export type ProjectRegistryDaemonServerIp = {
  current(): string | undefined
  start(): void
  shutdown(): void
}
