import { open } from "node:fs/promises"
import type { DevLeaseActivityFilesystem } from "./DevLeaseActivityFilesystem.js"

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

export function devLeaseActivityFilesystemDefault(): DevLeaseActivityFilesystem {
  return {
    async readTail(path, maxBytes) {
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(path, "r")
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error(`dev lease activity log is not a regular file: ${path}`)
        if (stat.size === 0) return new Uint8Array()
        const length = Math.min(stat.size, maxBytes)
        const buffer = Buffer.allocUnsafe(length)
        await handle.read(buffer, 0, length, Math.max(0, stat.size - length))
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      } catch (error) {
        if (missingFile(error)) return undefined
        throw error
      } finally {
        try {
          await handle?.close()
        } catch {
          // A close failure must not mask the read result.
        }
      }
    },
  }
}
