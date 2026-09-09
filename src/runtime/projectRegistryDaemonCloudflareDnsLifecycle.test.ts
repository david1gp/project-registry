import { describe, expect, test } from "bun:test"
import { createResult, createResultError } from "#result"
import type { Project } from "../project/Project.js"
import type { ProjectRegistryDaemonCloudflareDnsTracking } from "./ProjectRegistryDaemonCloudflareDnsTracking.js"
import type { ProjectRegistryDaemonCloudflareDnsTrackingState } from "./ProjectRegistryDaemonCloudflareDnsTrackingState.js"
import { projectRegistryDaemonCloudflareDnsCreate } from "./projectRegistryDaemonCloudflareDnsCreate.js"

function project(name: string, domains: string[], owner = "leo"): Project {
  return {
    schemaVersion: 1,
    owner,
    name,
    type: "customer",
    order: 0,
    services: [],
    labels: {},
    caddy: {
      port: 4300,
      domains,
      path: "/srv/app",
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
} {
  const callbacks: Array<() => void> = []
  return {
    timer: {
      setInterval(callback) {
        callbacks.push(callback)
        return callback
      },
      clearInterval() {},
    },
    tick() {
      callbacks[0]?.()
    },
  }
}

function trackingCreate(initial: ProjectRegistryDaemonCloudflareDnsTrackingState): {
  tracking: ProjectRegistryDaemonCloudflareDnsTracking
  state: ProjectRegistryDaemonCloudflareDnsTrackingState
  writes: number
} {
  const value = { state: structuredClone(initial), writes: 0 }
  return {
    get tracking() {
      return {
        read: async () => createResult(structuredClone(value.state)),
        write: async (next: ProjectRegistryDaemonCloudflareDnsTrackingState) => {
          value.state = structuredClone(next)
          value.writes += 1
          return createResult(undefined)
        },
      }
    },
    get state() {
      return value.state
    },
    get writes() {
      return value.writes
    },
  }
}

function fetchCreate(
  records: Map<string, { id: string; name: string; type: string; content: string; ttl: number; proxied: boolean }>,
  calls: string[],
) {
  let nextId = 1
  return async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    calls.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`)
    if (url.pathname.endsWith("/zones")) {
      return new Response(JSON.stringify({ success: true, result: [{ id: "zone", name: "example.com" }] }), {
        status: 200,
      })
    }
    if (init.method === "GET") {
      const id = url.pathname.split("/").pop()!
      if (url.searchParams.has("name")) {
        const record = [...records.values()].find((entry) => entry.name === url.searchParams.get("name"))
        return new Response(JSON.stringify({ success: true, result: record === undefined ? [] : [record] }), {
          status: 200,
        })
      }
      const record = records.get(id)
      return record === undefined
        ? new Response(JSON.stringify({ success: false }), { status: 404 })
        : new Response(JSON.stringify({ success: true, result: record }), { status: 200 })
    }
    if (init.method === "DELETE") {
      const id = url.pathname.split("/").pop()!
      records.delete(id)
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
    }
    const body = JSON.parse(String(init.body)) as {
      name: string
      type: string
      content: string
      ttl: number
      proxied: boolean
    }
    const id = init.method === "POST" ? `record-${nextId++}` : url.pathname.split("/").pop()!
    const record = { ...body, id }
    records.set(id, record)
    return new Response(JSON.stringify({ success: true, result: record }), { status: 200 })
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

describe("projectRegistryDaemonCloudflareDns lifecycle", () => {
  test("persists ownership, edits tracked domains, and deletes only tracked records", async () => {
    const timer = timerCreate()
    const records = new Map<
      string,
      { id: string; name: string; type: string; content: string; ttl: number; proxied: boolean }
    >()
    const calls: string[] = []
    const stored = trackingCreate({ version: 1, records: [] })
    let projects: Project[] = []
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "token",
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      fetch: fetchCreate(records, calls),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)

    const first = project("app", ["app.example.com"])
    projects = [first]
    queueR.data.projectCreateAfterPersistence(first, { noDns: false })
    await settle()
    expect(stored.state.records).toHaveLength(1)
    expect(stored.state.records[0]?.projectKeys).toEqual([{ owner: "leo", name: "app" }])

    const second = project("app", ["new.example.com"])
    projects = [second]
    queueR.data.projectEditAfterPersistence(first, second)
    await settle()
    expect(calls.some((call) => call.startsWith("DELETE "))).toBe(true)
    expect(stored.state.records.map((record) => record.name)).toEqual(["new.example.com"])

    projects = []
    queueR.data.projectDeleteAfterPersistence(second)
    await settle()
    expect(records.size).toBe(0)
    expect(stored.state.records).toEqual([])
    expect(calls.filter((call) => call.startsWith("DELETE "))).toHaveLength(2)
    await queueR.data.shutdown()
  })

  test("restarts orphan deletion without waiting for server IP", async () => {
    const timer = timerCreate()
    const records = new Map([
      [
        "record-1",
        { id: "record-1", name: "orphan.example.com", type: "A", content: "203.0.113.10", ttl: 1, proxied: true },
      ],
    ])
    const stored = trackingCreate({
      version: 1,
      records: [
        {
          zoneId: "zone",
          zoneName: "example.com",
          id: "record-1",
          name: "orphan.example.com",
          type: "A",
          content: "203.0.113.10",
          ttl: 1,
          proxied: true,
          projectKeys: [{ owner: "leo", name: "removed" }],
        },
      ],
    })
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "token",
      timeoutMs: 1000,
      serverIpCurrent: () => undefined,
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult([]),
      fetch: fetchCreate(records, []),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()
    await settle()
    expect(records.size).toBe(0)
    expect(stored.state.records).toEqual([])
    await queueR.data.shutdown()
  })

  test("keeps a shared tracked record until its last project is deleted", async () => {
    const timer = timerCreate()
    const records = new Map<
      string,
      { id: string; name: string; type: string; content: string; ttl: number; proxied: boolean }
    >()
    const stored = trackingCreate({ version: 1, records: [] })
    let projects: Project[] = []
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "token",
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      fetch: fetchCreate(records, []),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()

    const first = project("first", ["shared.example.com"])
    const second = project("second", ["shared.example.com"], "david")
    projects = [first]
    queueR.data.projectCreateAfterPersistence(first, { noDns: false })
    await settle()
    projects = [first, second]
    queueR.data.projectCreateAfterPersistence(second, { noDns: false })
    await settle()
    expect(stored.state.records[0]?.projectKeys).toEqual([
      { owner: "leo", name: "first" },
      { owner: "david", name: "second" },
    ])

    projects = [second]
    queueR.data.projectDeleteAfterPersistence(first)
    await settle()
    expect(records.size).toBe(1)
    expect(stored.state.records[0]?.projectKeys).toEqual([{ owner: "david", name: "second" }])

    projects = []
    queueR.data.projectDeleteAfterPersistence(second)
    await settle()
    expect(records.size).toBe(0)
    expect(stored.state.records).toEqual([])
    await queueR.data.shutdown()
  })

  test("does not lose an edit queued during an in-flight reconciliation", async () => {
    const timer = timerCreate()
    const records = new Map<
      string,
      { id: string; name: string; type: string; content: string; ttl: number; proxied: boolean }
    >()
    const stored = trackingCreate({ version: 1, records: [] })
    let projects: Project[] = []
    let releaseCreate!: () => void
    let createStarted!: () => void
    const createReady = new Promise<void>((resolve) => {
      createStarted = resolve
    })
    let blocked = true
    const fetchBase = fetchCreate(records, [])
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      if (blocked && init.method === "POST") {
        blocked = false
        createStarted()
        await new Promise<void>((resolve) => {
          releaseCreate = resolve
        })
      }
      return fetchBase(input, init)
    }
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "token",
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      fetch,
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()

    const first = project("app", ["first.example.com"])
    const edited = project("app", ["second.example.com"])
    projects = [first]
    queueR.data.projectCreateAfterPersistence(first, { noDns: false })
    await createReady
    projects = [edited]
    queueR.data.projectEditAfterPersistence(first, edited)
    releaseCreate()
    await settle()
    await settle()
    await settle()

    expect([...records.values()].map((record) => record.name)).toEqual(["second.example.com"])
    expect(stored.state.records.map((record) => record.name)).toEqual(["second.example.com"])
    await queueR.data.shutdown()
  })

  test("does not overwrite corrupt ownership state", async () => {
    const timer = timerCreate()
    let writes = 0
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      token: "token",
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: {
        read: async () => createResultError("test", "Cloudflare DNS tracking state is corrupt"),
        write: async () => {
          writes += 1
          return createResult(undefined)
        },
      },
      repositoryProjectsCurrent: async () => createResult([]),
      fetch: async () => new Response("unexpected", { status: 500 }),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()
    queueR.data.projectCreateAfterPersistence(project("app", ["app.example.com"]), { noDns: false })
    await settle()
    expect(writes).toBe(0)
    await queueR.data.shutdown()
  })
})
