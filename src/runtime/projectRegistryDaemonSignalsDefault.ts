import type { ProjectRegistryDaemonSignals } from "./ProjectRegistryDaemonSignals.js"

export function projectRegistryDaemonSignalsDefault(): ProjectRegistryDaemonSignals {
  return {
    on(signal, listener) {
      process.on(signal, listener)
      return () => process.off(signal, listener)
    },
  }
}
