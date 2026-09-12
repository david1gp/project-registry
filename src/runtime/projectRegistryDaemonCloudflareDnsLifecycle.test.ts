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

function canonicalProject(
  name: string,
  ownership: "registry" | "external",
  owner = "leo",
  domains = [`${name}.example.com`],
): Project {
  return {
    schemaVersion: 2,
    owner,
    name,
    type: "customer",
    order: 0,
    services: [
      {
        id: "default",
        units: [],
        ownership,
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
      },
    ],
    labels: {},
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
  authorizations: string[] = [],
) {
  let nextId = 1
  return async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    calls.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`)
    authorizations.push(new Headers(init.headers).get("authorization") ?? "")
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
      credentialResolve: async () => createResult("token"),
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
      credentialResolve: async () => createResult("token"),
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
    const authorizations: string[] = []
    let projects: Project[] = []
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async (owner) => createResult(`${owner}-token`),
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      fetch: fetchCreate(records, [], authorizations),
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
    expect(authorizations).toContain("Bearer leo-token")
    expect(authorizations).toContain("Bearer david-token")
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
      credentialResolve: async () => createResult("token"),
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

  test("retains a persisted pending delete for its original owner until that token appears", async () => {
    const timer = timerCreate()
    const records = new Map([
      [
        "record-1",
        { id: "record-1", name: "orphan.example.com", type: "A", content: "203.0.113.10", ttl: 1, proxied: true },
      ],
    ])
    const authorizations: string[] = []
    const owners: string[] = []
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
    let now = 0
    let token: string | undefined
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async (owner) => {
        owners.push(owner)
        return createResult(token)
      },
      timeoutMs: 1000,
      serverIpCurrent: () => undefined,
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult([]),
      fetch: fetchCreate(records, [], authorizations),
      clock: () => now,
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()
    await settle()
    expect(records.size).toBe(1)
    expect(stored.state.records).toHaveLength(1)
    expect(owners).toEqual(["leo"])

    token = "leo-delete-token"
    now = 2_000
    timer.tick()
    await settle()
    expect(records.size).toBe(0)
    expect(stored.state.records).toEqual([])
    expect(owners).toEqual(["leo", "leo"])
    expect(new Set(authorizations)).toEqual(new Set(["Bearer leo-delete-token"]))
    await queueR.data.shutdown()
  })

  test("defers ambiguous persisted ownership without changing tracking or calling Cloudflare", async () => {
    const timer = timerCreate()
    const records = new Map([
      [
        "record-1",
        { id: "record-1", name: "shared.example.com", type: "A", content: "203.0.113.10", ttl: 1, proxied: true },
      ],
    ])
    const initial = {
      version: 1 as const,
      records: [
        {
          zoneId: "zone",
          zoneName: "example.com",
          id: "record-1",
          name: "shared.example.com",
          type: "A",
          content: "203.0.113.10",
          ttl: 1,
          proxied: true,
          projectKeys: [
            { owner: "leo", name: "first" },
            { owner: "david", name: "second" },
          ],
        },
      ],
    }
    const stored = trackingCreate(initial)
    const owners: string[] = []
    const calls: string[] = []
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async (owner) => {
        owners.push(owner)
        return createResult(`${owner}-token`)
      },
      timeoutMs: 1000,
      serverIpCurrent: () => undefined,
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult([]),
      fetch: fetchCreate(records, calls),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()
    await settle()
    expect(stored.state).toEqual(initial)
    expect(records.size).toBe(1)
    expect(owners).toEqual([])
    expect(calls).toEqual([])
    await queueR.data.shutdown()
  })

  test("relinquishes registry DNS on external transition and reacquires it when restored", async () => {
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
      credentialResolve: async () => createResult("token"),
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      fetch: fetchCreate(records, calls),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()

    const registry = canonicalProject("app", "registry")
    projects = [registry]
    queueR.data.projectCreateAfterPersistence(registry, { noDns: false })
    await settle()
    expect(records.size).toBe(1)
    const callsAfterCreate = calls.length

    const external = canonicalProject("app", "external")
    projects = [external]
    queueR.data.projectEditAfterPersistence(registry, external)
    await settle()
    expect(records.size).toBe(1)
    expect(stored.state.records).toEqual([])
    expect(calls.slice(callsAfterCreate).some((call) => call.startsWith("DELETE "))).toBe(false)

    timer.tick()
    await settle()
    expect(calls.slice(callsAfterCreate).some((call) => call.includes("/dns_records"))).toBe(false)

    const restored = canonicalProject("app", "registry")
    const externalRecord = records.get("record-1")
    if (externalRecord !== undefined) externalRecord.content = "198.51.100.20"
    projects = [restored]
    queueR.data.projectEditAfterPersistence(external, restored)
    await settle()
    expect(calls.some((call) => call.startsWith("PUT "))).toBe(true)
    expect(stored.state.records).toHaveLength(1)

    const putsBeforeRecurring = calls.filter((call) => call.startsWith("PUT ")).length
    const restoredRecord = records.get("record-1")
    if (restoredRecord !== undefined) restoredRecord.content = "198.51.100.21"
    timer.tick()
    await settle()
    expect(calls.filter((call) => call.startsWith("PUT ")).length).toBeGreaterThan(putsBeforeRecurring)

    projects = []
    queueR.data.projectDeleteAfterPersistence(restored)
    await settle()
    expect(records.size).toBe(0)
    await queueR.data.shutdown()
  })

  test("does not reconcile externally owned services on create or recurring scans", async () => {
    const timer = timerCreate()
    const calls: string[] = []
    let projects: Project[] = []
    const external = canonicalProject("pages", "external")
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult("token"),
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      repositoryProjectsCurrent: async () => createResult(projects),
      fetch: fetchCreate(new Map(), calls),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()
    projects = [external]
    queueR.data.projectCreateAfterPersistence(external, { noDns: false })
    await settle()
    expect(calls).toEqual([])

    timer.tick()
    await settle()
    expect(calls).toEqual([])
    await queueR.data.shutdown()
  })

  test("leaves an externally owned proxied record untouched through deletion", async () => {
    const timer = timerCreate()
    const calls: string[] = []
    const records = new Map([
      [
        "record-1",
        { id: "record-1", name: "api.allgroups.chat", type: "A", content: "198.51.100.20", ttl: 1, proxied: true },
      ],
    ])
    const external = canonicalProject("api", "external", "leo", ["api.allgroups.chat"])
    const stored = trackingCreate({
      version: 1,
      records: [
        {
          zoneId: "zone",
          zoneName: "allgroups.chat",
          id: "record-1",
          name: "api.allgroups.chat",
          type: "A",
          content: "198.51.100.20",
          ttl: 1,
          proxied: true,
          projectKeys: [{ owner: "leo", name: "api" }],
        },
      ],
    })
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult("token"),
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: stored.tracking,
      fetch: fetchCreate(records, calls),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()
    await settle()
    queueR.data.projectCreateAfterPersistence(external, { noDns: false })
    await settle()
    queueR.data.projectDeleteAfterPersistence(external)
    await settle()

    expect(records.get("record-1")?.proxied).toBe(true)
    expect(calls).toEqual([])
    await queueR.data.shutdown()
  })

  test("does not create, update, or delete pages.dev records, including stale tracking", async () => {
    const timer = timerCreate()
    const calls: string[] = []
    const records = new Map([
      [
        "record-1",
        { id: "record-1", name: "site.pages.dev", type: "A", content: "198.51.100.20", ttl: 1, proxied: true },
      ],
    ])
    const stored = trackingCreate({
      version: 1,
      records: [
        {
          zoneId: "zone",
          zoneName: "pages.dev",
          id: "record-1",
          name: "site.pages.dev",
          type: "A",
          content: "198.51.100.20",
          ttl: 1,
          proxied: true,
          projectKeys: [{ owner: "leo", name: "site" }],
        },
      ],
    })
    let projects: Project[] = []
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult("token"),
      timeoutMs: 1000,
      serverIpCurrent: () => "203.0.113.10",
      timer: timer.timer,
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      fetch: fetchCreate(records, calls),
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    queueR.data.start()
    await settle()
    expect(stored.state.records).toEqual([])

    const first = canonicalProject("site", "registry", "leo", ["site.pages.dev"])
    projects = [first]
    queueR.data.projectCreateAfterPersistence(first, { noDns: false })
    await settle()
    const second = canonicalProject("site", "registry", "leo", ["changed.pages.dev"])
    projects = [second]
    queueR.data.projectEditAfterPersistence(first, second)
    await settle()
    projects = []
    queueR.data.projectDeleteAfterPersistence(second)
    await settle()

    expect(records.get("record-1")?.proxied).toBe(true)
    expect(calls).toEqual([])
    await queueR.data.shutdown()
  })

  test("does not overwrite corrupt ownership state", async () => {
    const timer = timerCreate()
    let writes = 0
    const queueR = projectRegistryDaemonCloudflareDnsCreate({
      enabled: true,
      credentialResolve: async () => createResult("token"),
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
