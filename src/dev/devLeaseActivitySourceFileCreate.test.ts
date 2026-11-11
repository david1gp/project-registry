import { describe, expect, test } from "bun:test"
import type { DevLeaseActivityFilesystem } from "./DevLeaseActivityFilesystem.js"
import { devLeaseActivitySourceFileCreate } from "./devLeaseActivitySourceFileCreate.js"

function filesystemCreate(tail: Uint8Array | undefined | Error): DevLeaseActivityFilesystem & {
  calls: Array<{ path: string; maxBytes: number }>
} {
  const calls: Array<{ path: string; maxBytes: number }> = []
  return {
    calls,
    async readTail(path, maxBytes) {
      calls.push({ path, maxBytes })
      if (tail instanceof Error) throw tail
      return tail
    },
  }
}

function logLine(host: string, ts: number): string {
  return JSON.stringify({ ts, request: { method: "GET", host, uri: "/" }, status: 200 })
}

describe("devLeaseActivitySourceFileCreate", () => {
  test("rejects missing paths, invalid filesystems, and invalid tail sizes", () => {
    const filesystem = filesystemCreate(undefined)
    expect(devLeaseActivitySourceFileCreate({ path: "", filesystem }).success).toBe(false)
    expect(
      devLeaseActivitySourceFileCreate({ path: "/logs/dev-leases/access.jsonl", filesystem: undefined as never })
        .success,
    ).toBe(false)
    expect(
      devLeaseActivitySourceFileCreate({ path: "/logs/dev-leases/access.jsonl", filesystem, maxTailBytes: 0 }).success,
    ).toBe(false)
    expect(
      devLeaseActivitySourceFileCreate({
        path: "/logs/dev-leases/access.jsonl",
        filesystem,
        maxTailBytes: 1024 * 1024 + 1,
      }).success,
    ).toBe(false)
  })

  test("returns no observations for a missing or empty log", async () => {
    for (const tail of [undefined, new Uint8Array()]) {
      const sourceR = devLeaseActivitySourceFileCreate({
        path: "/logs/dev-leases/access.jsonl",
        filesystem: filesystemCreate(tail),
        clock: () => 9_000,
      })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) continue
      await expect(sourceR.data.hostsCurrent()).resolves.toEqual([])
    }
  })

  test("treats an unreadable log as zero observations instead of failing", async () => {
    const sourceR = devLeaseActivitySourceFileCreate({
      path: "/logs/dev-leases/access.jsonl",
      filesystem: filesystemCreate(new Error("EACCES")),
      clock: () => 9_000,
    })
    expect(sourceR.success).toBe(true)
    if (!sourceR.success) return
    await expect(sourceR.data.hostsCurrent()).resolves.toEqual([])
  })

  test("extracts the newest timestamp per host and skips malformed lines", async () => {
    const body = [
      logLine("tim-akademie.wonder1.de", 5),
      "not-json",
      JSON.stringify({ ts: 6, status: 200 }),
      JSON.stringify({ ts: 6, request: { host: "", uri: "/" } }),
      logLine("tim-akademie.wonder1.de", 7),
      logLine("tim-werkstatt.wonder1.de", 8),
      "",
    ].join("\n")
    const filesystem = filesystemCreate(new TextEncoder().encode(body))
    const sourceR = devLeaseActivitySourceFileCreate({
      path: "/logs/dev-leases/access.jsonl",
      filesystem,
      clock: () => 9_000,
    })
    expect(sourceR.success).toBe(true)
    if (!sourceR.success) return

    await expect(sourceR.data.hostsCurrent()).resolves.toEqual([
      { host: "tim-akademie.wonder1.de", seenAt: 7_000 },
      { host: "tim-werkstatt.wonder1.de", seenAt: 8_000 },
    ])
    expect(filesystem.calls).toEqual([{ path: "/logs/dev-leases/access.jsonl", maxBytes: 64 * 1024 }])
  })

  test("clamps future record timestamps to the reconcile clock", async () => {
    const filesystem = filesystemCreate(new TextEncoder().encode(`${logLine("tim-akademie.wonder1.de", 60)}\n`))
    const sourceR = devLeaseActivitySourceFileCreate({
      path: "/logs/dev-leases/access.jsonl",
      filesystem,
      clock: () => 9_000,
    })
    expect(sourceR.success).toBe(true)
    if (!sourceR.success) return

    await expect(sourceR.data.hostsCurrent()).resolves.toEqual([{ host: "tim-akademie.wonder1.de", seenAt: 9_000 }])
  })

  test("recovers the tail cut mid-line by skipping the fragment", async () => {
    const full = `${logLine("tim-akademie.wonder1.de", 5)}\n${logLine("tim-werkstatt.wonder1.de", 6)}\n`
    const bytes = new TextEncoder().encode(full)
    const filesystem = filesystemCreate(bytes.slice(20))
    const sourceR = devLeaseActivitySourceFileCreate({
      path: "/logs/dev-leases/access.jsonl",
      filesystem,
      clock: () => 9_000,
    })
    expect(sourceR.success).toBe(true)
    if (!sourceR.success) return

    await expect(sourceR.data.hostsCurrent()).resolves.toEqual([{ host: "tim-werkstatt.wonder1.de", seenAt: 6_000 }])
  })
})
