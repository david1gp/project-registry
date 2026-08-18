export type ProjectRegistryDaemonSignals = {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): () => void
}
