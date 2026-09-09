import { describe, expect, test } from "bun:test"
import type { ProjectRegistryDaemonServerIpFilesystem } from "./ProjectRegistryDaemonServerIpFilesystem.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonServerIpCreate } from "./projectRegistryDaemonServerIpCreate.js"

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function filesystemCreate(initial: Record<string, string> = {}): {
  filesystem: ProjectRegistryDaemonServerIpFilesystem
  files: Map<string, string>
  writes: string[]
  renames: Array<{ source: string; destination: string }>
} {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const renames: Array<{ source: string; destination: string }> = []
  const filesystem: ProjectRegistryDaemonServerIpFilesystem = {
    async readFile(path) {
      const value = files.get(path)
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return value
    },
    async mkdir() {},
    async writeFile(path, value) {
      writes.push(path)
      files.set(path, value)
    },
    async rename(source, destination) {
      const value = files.get(source)
      if (value === undefined) throw new Error("temporary file is missing")
      files.delete(source)
      files.set(destination, value)
      renames.push({ source, destination })
    },
    async unlink(path) {
      files.delete(path)
    },
  }
  return { filesystem, files, writes, renames }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

describe("projectRegistryDaemonConfigFromEnv server IP", () => {
  test("accepts IPv4 and IPv6 overrides and configures the cache", () => {
    const result = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      SERVER_IP: "2001:db8::10",
      PROJECT_REGISTRY_SERVER_IP_CACHE_PATH: "/var/lib/project-registry/server-ip",
      PROJECT_REGISTRY_SERVER_IP_DISCOVERY_TIMEOUT_MS: "1500",
    })
    expect(result).toMatchObject({
      success: true,
      data: {
        serverIp: "2001:db8::10",
        serverIpCachePath: "/var/lib/project-registry/server-ip",
        serverIpDiscoveryTimeoutMs: 1500,
      },
    })
    expect(
      projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
        SERVER_IP: "not-an-ip",
      }).success,
    ).toBe(false)
  })
})

describe("projectRegistryDaemonServerIpCreate", () => {
  test("uses a valid override without reading cache or discovering", async () => {
    const cache = filesystemCreate({ "/tmp/server-ip": "198.51.100.10" })
    let reads = 0
    const originalReadFile = cache.filesystem.readFile
    cache.filesystem.readFile = async (path) => {
      reads += 1
      return originalReadFile(path)
    }
    let fetches = 0
    const result = projectRegistryDaemonServerIpCreate({
      override: "2001:db8::10",
      cachePath: "/tmp/server-ip",
      timeoutMs: 1000,
      filesystem: cache.filesystem,
      fetch: async () => {
        fetches += 1
        return new Response("198.51.100.20")
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    result.data.start()
    await settle()
    expect(result.data.current()).toBe("2001:db8::10")
    expect(reads).toBe(0)
    expect(fetches).toBe(0)
    result.data.shutdown()
  })

  test("loads cache, discovers once, logs elapsed outcome, and persists atomically", async () => {
    const cache = filesystemCreate({ "/tmp/server-ip": "198.51.100.10\n" })
    const discovery = deferred<Response>()
    const fetchStarted = deferred<void>()
    const logs: string[] = []
    let now = 1000
    let fetches = 0
    const result = projectRegistryDaemonServerIpCreate({
      cachePath: "/tmp/server-ip",
      timeoutMs: 1000,
      filesystem: cache.filesystem,
      fetch: async (_input, _init) => {
        fetches += 1
        fetchStarted.resolve()
        return discovery.promise
      },
      logger: (message) => logs.push(message),
      clock: () => now,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    result.data.start()
    await fetchStarted.promise
    expect(result.data.current()).toBe("198.51.100.10")
    result.data.start()
    now = 1015
    discovery.resolve(new Response("203.0.113.20\n"))
    await settle()
    expect(fetches).toBe(1)
    expect(result.data.current()).toBe("203.0.113.20")
    expect(cache.files.get("/tmp/server-ip")).toBe("203.0.113.20\n")
    expect(cache.writes).toEqual([`/tmp/server-ip.tmp-${process.pid}`])
    expect(cache.renames).toEqual([{ source: `/tmp/server-ip.tmp-${process.pid}`, destination: "/tmp/server-ip" }])
    expect(logs[0]).toContain("server IP discovery started")
    expect(logs[1]).toContain("server IP discovery outcome=success")
    expect(logs[1]).toContain("elapsedMs=15")
    result.data.shutdown()
  })

  test("retains cache on remote failure and timeout", async () => {
    const cache = filesystemCreate({ "/tmp/server-ip": "198.51.100.10" })
    const logs: string[] = []
    const result = projectRegistryDaemonServerIpCreate({
      cachePath: "/tmp/server-ip",
      timeoutMs: 10,
      filesystem: cache.filesystem,
      fetch: async () => new Response("unavailable", { status: 503 }),
      logger: (message) => logs.push(message),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    result.data.start()
    await settle()
    expect(result.data.current()).toBe("198.51.100.10")
    expect(cache.files.get("/tmp/server-ip")).toBe("198.51.100.10")
    expect(logs.some((message) => message.includes("outcome=failure"))).toBe(true)

    const timeoutCache = filesystemCreate({ "/tmp/server-ip-timeout": "198.51.100.11" })
    const timeoutLogs: string[] = []
    const timeoutResult = projectRegistryDaemonServerIpCreate({
      cachePath: "/tmp/server-ip-timeout",
      timeoutMs: 1,
      filesystem: timeoutCache.filesystem,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
      logger: (message) => timeoutLogs.push(message),
    })
    expect(timeoutResult.success).toBe(true)
    if (!timeoutResult.success) return
    timeoutResult.data.start()
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10))
    expect(timeoutResult.data.current()).toBe("198.51.100.11")
    expect(timeoutLogs.some((message) => message.includes("reason=timeout"))).toBe(true)
    timeoutResult.data.shutdown()
    result.data.shutdown()
  })

  test("cancels discovery on shutdown and ignores a late response", async () => {
    const cache = filesystemCreate({ "/tmp/server-ip": "198.51.100.12" })
    const discovery = deferred<Response>()
    const fetchStarted = deferred<void>()
    const logs: string[] = []
    const result = projectRegistryDaemonServerIpCreate({
      cachePath: "/tmp/server-ip",
      timeoutMs: 1000,
      filesystem: cache.filesystem,
      fetch: async () => {
        fetchStarted.resolve()
        return discovery.promise
      },
      logger: (message) => logs.push(message),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    result.data.start()
    await fetchStarted.promise
    result.data.shutdown()
    discovery.resolve(new Response("203.0.113.30"))
    await settle()
    expect(result.data.current()).toBe("198.51.100.12")
    expect(cache.files.get("/tmp/server-ip")).toBe("198.51.100.12")
    expect(logs.some((message) => message.includes("outcome=cancelled"))).toBe(true)
  })

  test("rejects an invalid override", () => {
    const result = projectRegistryDaemonServerIpCreate({
      override: "not-an-ip",
      cachePath: "/tmp/server-ip",
      timeoutMs: 1000,
      filesystem: filesystemCreate().filesystem,
      fetch: async () => new Response("198.51.100.10"),
    })
    expect(result.success).toBe(false)
  })
})
