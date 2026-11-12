/**
 * Spawn seam for `journalctl`: returns the process stdout as a stream (for
 * `-f`) plus a cancel hook that kills the child when the client disconnects.
 */
export type ManagedServiceLogStreamer = (args: readonly string[]) => {
  stdout: ReadableStream<Uint8Array>
  cancel: () => void
}
