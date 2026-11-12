import type { ManagedServiceLogStreamer } from "./ManagedServiceLogStreamer.js"

/** Production `journalctl` streamer: argv only, never a shell; stderr is discarded. */
export function managedServiceLogStreamerDefault(): ManagedServiceLogStreamer {
  return (args) => {
    const spawned = Bun.spawn(["journalctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    return {
      stdout: spawned.stdout,
      cancel: () => {
        try {
          spawned.kill()
        } catch {
          // Already exited.
        }
      },
    }
  }
}
