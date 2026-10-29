import { describe, expect, test } from "bun:test"
import { createResult, createResultError } from "#result"
import type { Project } from "../project/Project.js"
import type { TailscaleSplitDnsFetch } from "../tailscale/TailscaleSplitDnsFetch.js"
import type { ProjectRegistryDaemonPrivateDnsTracking } from "./ProjectRegistryDaemonPrivateDnsTracking.js"
import type { ProjectRegistryDaemonPrivateDnsTrackingFilesystem } from "./ProjectRegistryDaemonPrivateDnsTrackingFilesystem.js"
import type { ProjectRegistryDaemonPrivateDnsTrackingState } from "./ProjectRegistryDaemonPrivateDnsTrackingState.js"
import { projectRegistryDaemonPrivateDnsCreate } from "./projectRegistryDaemonPrivateDnsCreate.js"

const nodeAddress = "100.122.200.114"
const dnsmasqConfigPath = "/etc/project-registry/private-dnsmasq.conf"

function project(name: string, domains: string[], owner = "leo"): Project {
  return {
    schemaVersion: 2,
    owner,
    name,
    order: 0,
    services: [
      {
        id: "default",
        units: [],
        ownership: "registry",
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
          networkVisibility: "private",
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

function trackingCreate(initial: ProjectRegistryDaemonPrivateDnsTrackingState): {
  tracking: ProjectRegistryDaemonPrivateDnsTracking
  state: ProjectRegistryDaemonPrivateDnsTrackingState
  writes: number
} {
  const value = { state: structuredClone(initial), writes: 0 }
  return {
    get tracking() {
      return {
        read: async () => createResult(structuredClone(value.state)),
        write: async (next: ProjectRegistryDaemonPrivateDnsTrackingState) => {
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

function filesystemCreate(files = new Map<string, string>()): {
  filesystem: ProjectRegistryDaemonPrivateDnsTrackingFilesystem
  files: Map<string, string>
} {
  const filesystem: ProjectRegistryDaemonPrivateDnsTrackingFilesystem = {
    readFile: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return value
    },
    mkdir: async () => undefined,
    writeFile: async (path, value) => {
      files.set(path, value)
    },
    rename: async (source, destination) => {
      const value = files.get(source)
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      files.delete(source)
      files.set(destination, value)
    },
    unlink: async (path) => {
      files.delete(path)
    },
  }
  return { filesystem, files }
}

function splitDnsFetchCreate(
  map: Map<string, string[]>,
  calls: string[],
  bodies: unknown[],
): { fetch: TailscaleSplitDnsFetch; map: Map<string, string[]> } {
  const fetchImpl = (async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    calls.push(`${init.method ?? "GET"} ${url.pathname}`)
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(Object.fromEntries(map)), { status: 200 })
    }
    const body = JSON.parse(init.body as string) as Record<string, string[] | null>
    bodies.push(body)
    for (const [hostname, value] of Object.entries(body)) {
      if (value === null) map.delete(hostname)
      else map.set(hostname, value)
    }
    return new Response(JSON.stringify(Object.fromEntries(map)), { status: 200 })
  }) as TailscaleSplitDnsFetch
  return { fetch: fetchImpl, map }
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  }
}

describe("projectRegistryDaemonPrivateDns lifecycle", () => {
  test("persists ownership, renames create-before-delete, and deletes only tracked hosts", async () => {
    const timer = timerCreate()
    const live = new Map<string, string[]>([["other.example.com", ["9.9.9.9"]]])
    const calls: string[] = []
    const bodies: unknown[] = []
    const { fetch } = splitDnsFetchCreate(live, calls, bodies)
    const stored = trackingCreate({ version: 1, hosts: [] })
    const files = filesystemCreate()
    let reloads = 0
    let projects: Project[] = []
    const queueR = projectRegistryDaemonPrivateDnsCreate({
      enabled: true,
      tailnet: "example.com",
      nodeAddress,
      upstreamResolvers: ["1.1.1.1"],
      dnsmasqConfigPath,
      splitDnsStateDirectory: "/var/lib/project-registry/private-dns",
      credentialResolve: async () => createResult("tskey-test"),
      fetch,
      filesystem: files.filesystem,
      resolverReload: async () => {
        reloads += 1
        return createResult(undefined)
      },
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      timer: timer.timer,
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)

    const first = project("app", ["app.wonder1.de"])
    projects = [first]
    queueR.data.projectCreateAfterPersistence(first, { noDns: false })
    await settle()
    expect(live.get("app.wonder1.de")).toEqual([nodeAddress])
    expect(stored.state.hosts).toHaveLength(1)
    expect(stored.state.hosts[0]).toMatchObject({
      hostname: "app.wonder1.de",
      owner: "leo",
      zone: "wonder1.de",
      projectKeys: [{ owner: "leo", name: "app" }],
    })
    const firstConfig = files.files.get(dnsmasqConfigPath) ?? ""
    expect(firstConfig).toContain("host-record=app.wonder1.de,100.122.200.114")
    expect(reloads).toBe(1)

    // Rename: the replacement PATCH lands before the old entry is cleared.
    const second = project("app", ["new.wonder1.de"])
    projects = [second]
    queueR.data.projectEditAfterPersistence(first, second)
    await settle()
    expect(live.get("new.wonder1.de")).toEqual([nodeAddress])
    expect(live.has("app.wonder1.de")).toBe(false)
    expect(stored.state.hosts.map((host) => host.hostname)).toEqual(["new.wonder1.de"])
    const patchBodies = bodies.filter((body) => typeof body === "object" && body !== null)
    const applyIndex = patchBodies.findIndex(
      (body) => JSON.stringify(body) === JSON.stringify({ "new.wonder1.de": [nodeAddress] }),
    )
    const removeIndex = patchBodies.findIndex(
      (body) => JSON.stringify(body) === JSON.stringify({ "app.wonder1.de": null }),
    )
    expect(applyIndex).toBeGreaterThanOrEqual(0)
    expect(removeIndex).toBeGreaterThan(applyIndex)

    projects = []
    queueR.data.projectDeleteAfterPersistence(second)
    await settle()
    expect(live.has("new.wonder1.de")).toBe(false)
    expect(stored.state.hosts).toEqual([])
    // The foreign split-DNS entry survives every cycle untouched.
    expect(live.get("other.example.com")).toEqual(["9.9.9.9"])
    expect(JSON.stringify(bodies)).not.toContain("other.example.com")
    expect(calls.every((call) => !call.startsWith("PUT"))).toBe(true)
    const lastConfig = files.files.get(dnsmasqConfigPath) ?? ""
    expect(lastConfig).not.toContain("host-record=")
    expect(queueR.data.status().errors).toEqual([])
    await queueR.data.shutdown()
  })

  test("restart recovery converges without redundant writes and deletes orphans", async () => {
    const live = new Map<string, string[]>([
      ["app.wonder1.de", [nodeAddress]],
      ["orphan.wonder1.de", [nodeAddress]],
    ])
    const calls: string[] = []
    const bodies: unknown[] = []
    const { fetch } = splitDnsFetchCreate(live, calls, bodies)
    const stored = trackingCreate({
      version: 1,
      hosts: [
        {
          hostname: "app.wonder1.de",
          owner: "leo",
          zone: "wonder1.de",
          nodeAddress,
          projectKeys: [{ owner: "leo", name: "app" }],
        },
        {
          hostname: "orphan.wonder1.de",
          owner: "leo",
          zone: "wonder1.de",
          nodeAddress,
          projectKeys: [{ owner: "leo", name: "gone" }],
        },
      ],
    })
    const files = filesystemCreate()
    let reloads = 0
    const projects = [project("app", ["app.wonder1.de"])]
    const queueR = projectRegistryDaemonPrivateDnsCreate({
      enabled: true,
      tailnet: "example.com",
      nodeAddress,
      upstreamResolvers: ["1.1.1.1"],
      dnsmasqConfigPath,
      splitDnsStateDirectory: "/var/lib/project-registry/private-dns",
      credentialResolve: async () => createResult("tskey-test"),
      fetch,
      filesystem: files.filesystem,
      resolverReload: async () => {
        reloads += 1
        return createResult(undefined)
      },
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      timer: timerCreate().timer,
    })
    if (!queueR.success) throw new Error("setup failed")
    expect(queueR.data.start().success).toBe(true)
    await settle(10)
    // The surviving host needs no PATCH; the orphan is removed and untracked.
    expect(JSON.stringify(bodies)).not.toContain("app.wonder1.de")
    expect(live.has("orphan.wonder1.de")).toBe(false)
    expect(stored.state.hosts.map((host) => host.hostname)).toEqual(["app.wonder1.de"])
    // Exactly one resolver reload: the converged config is written once.
    expect(reloads).toBe(1)
    const config = files.files.get(dnsmasqConfigPath) ?? ""
    expect(config).toContain("host-record=app.wonder1.de,100.122.200.114")
    expect(config).not.toContain("orphan.wonder1.de")
    expect(queueR.data.status().errors).toEqual([])
    await queueR.data.shutdown()
  })

  test("split-DNS authentication expiry defers with retry and recovers", async () => {
    let now = 2_000_000
    const timer = timerCreate()
    const live = new Map<string, string[]>()
    const calls: string[] = []
    let expired = true
    const fetchImpl = (async (input: string, init: RequestInit): Promise<Response> => {
      const url = new URL(input)
      calls.push(`${init.method ?? "GET"} ${url.pathname}`)
      if (expired) return new Response(JSON.stringify({ message: "expired" }), { status: 401 })
      if ((init.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
      }
      const body = JSON.parse(init.body as string) as Record<string, string[] | null>
      for (const [hostname, value] of Object.entries(body)) {
        if (value === null) live.delete(hostname)
        else live.set(hostname, value)
      }
      return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
    }) as TailscaleSplitDnsFetch
    const stored = trackingCreate({ version: 1, hosts: [] })
    const files = filesystemCreate()
    const projects = [project("app", ["app.wonder1.de"])]
    const queueR = projectRegistryDaemonPrivateDnsCreate({
      enabled: true,
      tailnet: "example.com",
      nodeAddress,
      upstreamResolvers: ["1.1.1.1"],
      dnsmasqConfigPath,
      splitDnsStateDirectory: "/var/lib/project-registry/private-dns",
      credentialResolve: async () => createResult("tskey-test"),
      fetch: fetchImpl,
      filesystem: files.filesystem,
      resolverReload: async () => createResult(undefined),
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      clock: () => now,
      timer: timer.timer,
    })
    if (!queueR.success) throw new Error("setup failed")
    expect(queueR.data.start().success).toBe(true)
    queueR.data.projectCreateAfterPersistence(projects[0]!, { noDns: false })
    await settle()
    expect(live.size).toBe(0)
    let status = queueR.data.status()
    expect(status.pendingProjects).toBe(1)
    expect(status.errors).toHaveLength(1)
    expect(status.errors[0]).toMatchObject({ operation: "split-dns-read", statusCode: 401 })
    expect(status.errors[0]?.nextRetryAt).toBe(now + 2_000)

    // After the key is rotated the same queue converges without residue.
    expired = false
    now += 2_001
    timer.tick()
    await settle()
    expect(live.get("app.wonder1.de")).toEqual([nodeAddress])
    status = queueR.data.status()
    expect(status.pendingProjects).toBe(0)
    expect(status.errors).toEqual([])
    expect(status.lastSuccess).toBe(now)
    await queueR.data.shutdown()
  })

  test("resolver reload failure defers and recovers without losing split-DNS state", async () => {
    let now = 3_000_000
    const timer = timerCreate()
    const live = new Map<string, string[]>()
    const { fetch } = splitDnsFetchCreate(live, [], [])
    const stored = trackingCreate({ version: 1, hosts: [] })
    const files = filesystemCreate()
    let reloads = 0
    let reloadBroken = true
    const projects = [project("app", ["app.wonder1.de"])]
    const queueR = projectRegistryDaemonPrivateDnsCreate({
      enabled: true,
      tailnet: "example.com",
      nodeAddress,
      upstreamResolvers: ["1.1.1.1"],
      dnsmasqConfigPath,
      splitDnsStateDirectory: "/var/lib/project-registry/private-dns",
      credentialResolve: async () => createResult("tskey-test"),
      fetch,
      filesystem: files.filesystem,
      resolverReload: async () => {
        reloads += 1
        return reloadBroken ? createResultError("reload", "unit failed") : createResult(undefined)
      },
      tracking: stored.tracking,
      repositoryProjectsCurrent: async () => createResult(projects),
      clock: () => now,
      timer: timer.timer,
    })
    if (!queueR.success) throw new Error("setup failed")
    expect(queueR.data.start().success).toBe(true)
    queueR.data.projectCreateAfterPersistence(projects[0]!, { noDns: false })
    await settle()
    // Split-DNS converged and is tracked even though the resolver reload failed.
    expect(live.get("app.wonder1.de")).toEqual([nodeAddress])
    expect(stored.state.hosts.map((host) => host.hostname)).toEqual(["app.wonder1.de"])
    // ...but the reload is not recorded as applied, so the config rewrites on retry.
    expect(stored.state.resolver).toBeUndefined()
    let status = queueR.data.status()
    expect(status.pendingProjects).toBe(1)
    expect(status.errors.map((entry) => entry.operation)).toEqual(["resolver-reload"])

    reloadBroken = false
    now += 2_001
    timer.tick()
    await settle()
    expect(reloads).toBe(2)
    expect(stored.state.resolver?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    status = queueR.data.status()
    expect(status.pendingProjects).toBe(0)
    expect(status.errors).toEqual([])
    await queueR.data.shutdown()
  })
})
