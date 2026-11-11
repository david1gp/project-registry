/**
 * Minimal tail-read seam for the dev-lease activity log. Returns the last
 * `maxBytes` of the file, or `undefined` when the file does not exist yet
 * (no request has been logged). Any other I/O failure rejects, and the
 * activity source treats it as zero observations for that tick.
 */
export type DevLeaseActivityFilesystem = {
  readTail(path: string, maxBytes: number): Promise<Uint8Array | undefined>
}
