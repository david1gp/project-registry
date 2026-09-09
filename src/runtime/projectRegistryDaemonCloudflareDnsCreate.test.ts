import { describe, expect, test } from "bun:test"
import type { Project } from "../project/Project.js"
import { projectRegistryDaemonCloudflareDnsCreate } from "./projectRegistryDaemonCloudflareDnsCreate.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"

function project(domains: string[]): Project {
  return {
    schemaVersion: 1,
    owner: "leo",
    name: "dns-app",
    type: "customer",
    order: Number.MAX_SAFE_INTEGER,
    services: [],
    labels: {},
    caddy: {
      port: 4300,
      domains,
      path: "",
      access: "external",
      kind: "proxy",
      docs: true,
      browse: false,
      headerUp: {},
      disabled: false,
      denyDotfiles: false,
      spa: false,
    },
  }
}

function timerCreate(): {
  timer: { setInterval(callback: () => void, delayMs: number): unknown; clearInterval(handle: unknown): void }
  tick(): void
  cleared: number
} {
  const callbacks: Array<() => void> = []
  let cleared = 0
  return {
    timer: {
      setInterval(callback) {
        callbacks.push(callback)
        return callback
      },
      clearInterval() {
        cleared += 1
      },
    },
    tick() {
      callbacks[0]?.()
    },
    get cleared() {
      return cleared
    },
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function cloudflareFetchCreate(calls: string[]): (input: string, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input)
    calls.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`)
    if (url.pathname.endsWith("/zones")) {
      return url.searchParams.get("name") === "example.com"
        ? json({ success: true, result: [{ id: "zone", name: "example.com", status: "active" }] })
        : json({ success: true, result: [] })
    }
    if (init.method === "GET") return json({ success: true, result: [] })
    return json({
      success: true,
      result: { id: "record", name: "app.example.com", type: "A", content: "203.0.113.10", ttl: 1, proxied: true },
    })
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

describe("projectRegistryDaemonConfigFromEnv Cloudflare DNS", () => {
  test("uses the preferred token, falls back, and honors the disable switch", () => {
    const preferred = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      CLOUDFLARE_API_TOKEN: "preferred-token",
      CF_API_TOKEN: "fallback-token",
    })
    expect(preferred).toMatchObject({
      success: true,
      data: { cloudflareDns: { enabled: true, token: "preferred-token" } },
    })

    const fallback = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      CF_API_TOKEN: "fallback-token",
    })
    expect(fallback).toMatchObject({
      success: true,
      data: { cloudflareDns: { enabled: true, token: "fallback-token" } },
    })

    const disabled = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      CLOUDFLARE_API_TOKEN: "preferred-token",
      PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED: "false",
    })
    expect(disabled).toMatchObject({
      success: true,
      data: { cloudflareDns: { enabled: false, token: "preferred-token" } },
    })

    const missing = projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository" })
    expect(missing).toMatchObject({ success: true, data: { cloudflareDns: { enabled: false } } })
  })
})

describe("projectRegistryDaemonCloudflareDnsCreate", () => {
  test("holds work while IP discovery is pending, then reconciles normalized aliases", async () => {
    const timer = timerCreate()
    const calls: string[] = []
    let currentIp: string | undefined
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "token",
      timeoutMs: 1000,
      serverIpCurrent: () => currentIp,
      timer: timer.timer,
      fetch: cloudflareFetchCreate(calls),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return

    expect(queueR.data.start().success).toBe(true)
    queueR.data.projectCreateAfterPersistence(project([" App.Example.COM. ", "alias.example.com"]), { noDns: false })
    await settle()
    expect(calls).toEqual([])

    currentIp = "203.0.113.10"
    timer.tick()
    await settle()
    await settle()
    expect(calls.some((call) => call.includes("name=app.example.com"))).toBe(true)
    expect(calls.some((call) => call.includes("name=alias.example.com"))).toBe(true)
    expect((await queueR.data.shutdown()).success).toBe(true)
    expect(timer.cleared).toBe(1)
  })

  test("skips missing credentials, global opt-out, and per-create opt-out without fetches", async () => {
    const cases = [
      { enabled: true, token: undefined },
      { enabled: false, token: "token" },
    ] as const
    for (const options of cases) {
      const timer = timerCreate()
      let fetches = 0
      const queueR = projectRegistryDaemonCloudflareDnsCreate({
        ...options,
        timeoutMs: 1000,
        serverIpCurrent: () => "203.0.113.10",
        timer: timer.timer,
        fetch: async () => {
          fetches += 1
          return new Response()
        },
      })
      expect(queueR.success).toBe(true)
      if (!queueR.success) continue
      expect(queueR.data.start().success).toBe(true)
      queueR.data.projectCreateAfterPersistence(project(["app.example.com"]), { noDns: false })
      queueR.data.projectCreateAfterPersistence(project(["skip.example.com"]), { noDns: true })
      await settle()
      expect(fetches).toBe(0)
      await queueR.data.shutdown()
    }
  })

  test("does not fail creation work when the remote API fails", async () => {
    const timer = timerCreate()
    let fetches = 0
    const logs: string[] = []
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "secret-token",
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      logger: (message) => logs.push(message),
      fetch: async () => {
        fetches += 1
        return new Response("unavailable", { status: 503 })
      },
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)
    queueR.data.projectCreateAfterPersistence(project(["app.example.com"]), { noDns: false })
    await settle()
    await settle()
    expect(fetches).toBeGreaterThan(0)
    expect(logs).toContain(
      "cloudflare DNS reconciliation outcome=failure hostname=app.example.com reason=Cloudflare DNS request failed",
    )
    expect(logs.some((message) => message.includes("secret-token"))).toBe(false)
    await expect(queueR.data.shutdown()).resolves.toMatchObject({ success: true })
  })

  test("cancels an in-flight remote request during shutdown", async () => {
    const timer = timerCreate()
    let fetchStarted = false
    let aborted = false
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "token",
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          fetchStarted = true
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new Error("aborted"))
            },
            { once: true },
          )
        }),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)
    queueR.data.projectCreateAfterPersistence(project(["app.example.com"]), { noDns: false })
    await settle()
    expect(fetchStarted).toBe(true)
    await expect(queueR.data.shutdown()).resolves.toMatchObject({ success: true })
    expect(aborted).toBe(true)
  })
})
