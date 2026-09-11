import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { Project } from "../project/Project.js"
import { projectRegistryDaemonCloudflareDnsCreate } from "./projectRegistryDaemonCloudflareDnsCreate.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"

function project(domains: string[], disabled = false, owner = "leo", name = "dns-app"): Project {
  return {
    schemaVersion: 2,
    owner,
    name,
    type: "customer",
    order: Number.MAX_SAFE_INTEGER,
    services: [
      {
        id: "default",
        units: [],
        ownership: "registry",
        caddy: {
          port: 4300,
          domains,
          path: "",
          access: "external",
          kind: "proxy",
          docs: true,
          browse: false,
          headerUp: {},
          disabled,
          denyDotfiles: false,
          spa: false,
        },
      },
    ],
    labels: {},
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

function cloudflareFetchCreate(
  calls: string[],
  authorizations: string[] = [],
): (input: string, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input)
    calls.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`)
    authorizations.push(new Headers(init.headers).get("authorization") ?? "")
    if (url.pathname.endsWith("/zones")) {
      return url.searchParams.get("name") === "example.com"
        ? json({ success: true, result: [{ id: "zone", name: "example.com", status: "active" }] })
        : json({ success: true, result: [] })
    }
    if (init.method === "GET") return json({ success: true, result: [] })
    const body = init.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>)
    return json({
      success: true,
      result: {
        id: "record",
        name: typeof body.name === "string" ? body.name : "app.example.com",
        type: typeof body.type === "string" ? body.type : "A",
        content: typeof body.content === "string" ? body.content : "203.0.113.10",
        ttl: typeof body.ttl === "number" ? body.ttl : 1,
        proxied: typeof body.proxied === "boolean" ? body.proxied : true,
      },
    })
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

describe("projectRegistryDaemonConfigFromEnv Cloudflare DNS", () => {
  test("uses the owner credentials directory, ignores global tokens, and honors the disable switch", () => {
    const preferred = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      CLOUDFLARE_API_TOKEN: "preferred-token",
      CF_API_TOKEN: "fallback-token",
    })
    expect(preferred).toMatchObject({
      success: true,
      data: { cloudflareDns: { enabled: true, credentialsDirectory: "/etc/project-registry/cloudflare" } },
    })
    expect(preferred.success ? preferred.data.cloudflareDns : undefined).toEqual({
      enabled: true,
      credentialsDirectory: "/etc/project-registry/cloudflare",
    })

    const fallback = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      CF_API_TOKEN: "fallback-token",
    })
    expect(fallback).toMatchObject({
      success: true,
      data: { cloudflareDns: { enabled: true, credentialsDirectory: "/etc/project-registry/cloudflare" } },
    })
    expect(fallback.success ? fallback.data.cloudflareDns : undefined).toEqual({
      enabled: true,
      credentialsDirectory: "/etc/project-registry/cloudflare",
    })

    const disabled = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      CLOUDFLARE_API_TOKEN: "preferred-token",
      PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED: "false",
    })
    expect(disabled).toMatchObject({
      success: true,
      data: { cloudflareDns: { enabled: false, credentialsDirectory: "/etc/project-registry/cloudflare" } },
    })
    expect(disabled.success ? disabled.data.cloudflareDns : undefined).toEqual({
      enabled: false,
      credentialsDirectory: "/etc/project-registry/cloudflare",
    })

    const missing = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      CLOUDFLARE_API_TOKEN: "global-token",
      CF_API_TOKEN: "legacy-global-token",
    })
    expect(missing).toMatchObject({
      success: true,
      data: { cloudflareDns: { enabled: true, credentialsDirectory: "/etc/project-registry/cloudflare" } },
    })
    expect(missing.success ? missing.data.cloudflareDns : undefined).toEqual({
      enabled: true,
      credentialsDirectory: "/etc/project-registry/cloudflare",
    })

    const custom = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_CLOUDFLARE_CREDENTIALS_DIR: "/srv/project-registry/cloudflare",
    })
    expect(custom.success ? custom.data.cloudflareDns : undefined).toEqual({
      enabled: true,
      credentialsDirectory: "/srv/project-registry/cloudflare",
    })
  })
})

describe("projectRegistryDaemonCloudflareDnsCreate", () => {
  test("uses the current owner credential for create, edit, and each reconciliation", async () => {
    const timer = timerCreate()
    const calls: string[] = []
    const authorizations: string[] = []
    const owners: string[] = []
    const tokens = new Map([
      ["leo", "leo-token-1"],
      ["david", "david-token-1"],
    ])
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async (owner) => {
        owners.push(owner)
        return createResult(tokens.get(owner))
      },
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      fetch: cloudflareFetchCreate(calls, authorizations),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)

    const leo = project(["app.example.com"], false, "leo", "leo-app")
    queueR.data.projectCreateAfterPersistence(leo, { noDns: false })
    await settle()
    tokens.set("leo", "leo-token-2")
    const edited = project(["edited.example.com"], false, "leo", "leo-app")
    queueR.data.projectEditAfterPersistence(leo, edited)
    await settle()
    const david = project(["david.example.com"], false, "david", "david-app")
    queueR.data.projectCreateAfterPersistence(david, { noDns: false })
    await settle()

    expect(owners).toEqual(["leo", "leo", "david"])
    expect(authorizations).toContain("Bearer leo-token-1")
    expect(authorizations).toContain("Bearer leo-token-2")
    expect(authorizations).toContain("Bearer david-token-1")
    await queueR.data.shutdown()
  })

  test("retries when an owner credential appears and rereads it after it changes", async () => {
    const timer = timerCreate()
    const authorizations: string[] = []
    let now = 0
    let token: string | undefined
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult(token),
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      fetch: cloudflareFetchCreate([], authorizations),
      clock: () => now,
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)
    const first = project(["app.example.com"])
    queueR.data.projectCreateAfterPersistence(first, { noDns: false })
    await settle()
    expect(authorizations).toEqual([])

    token = "appeared-token"
    now = 1_000
    timer.tick()
    await settle()
    expect(authorizations).toContain("Bearer appeared-token")

    token = "changed-token"
    queueR.data.projectEditAfterPersistence(first, project(["changed.example.com"]))
    await settle()
    expect(authorizations).toContain("Bearer changed-token")
    await queueR.data.shutdown()
  })

  test("holds work while IP discovery is pending, then reconciles normalized aliases", async () => {
    const timer = timerCreate()
    const calls: string[] = []
    let currentIp: string | undefined
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult("token"),
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
    const cases = [{ enabled: true }, { enabled: false }] as const
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

  test("does not reconcile disabled Caddy entries", async () => {
    const timer = timerCreate()
    let fetches = 0
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult("token"),
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      fetch: async () => {
        fetches += 1
        return new Response()
      },
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)
    queueR.data.projectCreateAfterPersistence(project(["disabled.example.com"], true), { noDns: false })
    await settle()
    expect(fetches).toBe(0)
    await queueR.data.shutdown()
  })

  test("does not fail creation work when the remote API fails", async () => {
    const timer = timerCreate()
    let fetches = 0
    const logs: string[] = []
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult("secret-token"),
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
      credentialResolve: async () => createResult("token"),
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
