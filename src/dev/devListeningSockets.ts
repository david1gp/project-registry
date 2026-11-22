import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"

/** Snapshot all TCP listeners, including IPv6 and sockets owned by other users. */
export async function devListeningSockets(runner: DevProcessRunner): PromiseResult<{ port: number; cgroup: string | undefined }[]> {
  const op = "devListeningSockets"
  try {
    const result = await runner("ss", ["-H", "-ltn", "--cgroup"], "")
    if (!result.success) return result
    if (result.data.exitCode !== 0) return createResultErrorCode(op, "cannot inspect listening sockets", "caddy.unavailable")
    const sockets: { port: number; cgroup: string | undefined }[] = []
    for (const line of result.data.stdout.split("\n")) {
      if (!line.trim()) continue
      const fields = line.trim().split(/\s+/)
      const match = fields[3]?.match(/:(\d+)$/)
      if (!match) return createResultErrorCode(op, "cannot parse listening sockets", "caddy.unavailable")
      sockets.push({ port: Number(match[1]), cgroup: line.match(/(?:^|\s)cgroup:(\S+)/)?.[1] })
    }
    return createResult(sockets)
  } catch {
    return createResultErrorCode(op, "cannot inspect listening sockets", "caddy.unavailable")
  }
}
