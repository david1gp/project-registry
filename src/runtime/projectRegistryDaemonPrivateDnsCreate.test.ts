import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { Project } from "../project/Project.js"
import type { TailscaleSplitDnsFetch } from "../tailscale/TailscaleSplitDnsFetch.js"
import type { ProjectRegistryDaemonPrivateDnsTrackingFilesystem } from "./ProjectRegistryDaemonPrivateDnsTrackingFilesystem.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonPrivateDnsCreate } from "./projectRegistryDaemonPrivateDnsCreate.js"

const nodeAddress = "100.122.200.114"

function project(
  domains: string[],
  options: { visibility?: "public" | "private"; disabled?: boolean; owner?: string; name?: string } = {},
): Project {
  return {
    schemaVersion: 2,
    owner: options.owner ?? "leo",
    name: options.name ?? "dns-app",
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
          disabled: options.disabled ?? false,
          denyDotfiles: false,
          spa: false,
          ...(options.visibility === undefined ? {} : { networkVisibility: options.visibility }),
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
): { fetch: TailscaleSplitDnsFetch; map: Map<string, string[]> } {
  const fetchImpl = (async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    calls.push(`${init.method ?? "GET"} ${url.pathname}`)
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(Object.fromEntries(map)), { status: 200 })
    }
    const body = JSON.parse(init.body as string) as Record<string, string[] | null>
    for (const [hostname, value] of Object.entries(body)) {
      if (value === null) map.delete(hostname)
      else map.set(hostname, value)
    }
    return new Response(JSON.stringify(Object.fromEntries(map)), { status: 200 })
  }) as TailscaleSplitDnsFetch
  return { fetch: fetchImpl, map }
}

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  }
}

function optionsCreate(
  overrides: Record<string, unknown> = {},
): Parameters<typeof projectRegistryDaemonPrivateDnsCreate>[0] {
  const { filesystem } = filesystemCreate()
  return {
    enabled: true,
    tailnet: "example.com",
    nodeAddress,
    upstreamResolvers: ["1.1.1.1"],
    dnsmasqConfigPath: "/etc/project-registry/private-dnsmasq.conf",
    splitDnsStateDirectory: "/var/lib/project-registry/private-dns",
    filesystem,
    timer: timerCreate().timer,
    ...(overrides as object),
  } as Parameters<typeof projectRegistryDaemonPrivateDnsCreate>[0]
}

describe("projectRegistryDaemonPrivateDnsCreate validation", () => {
  test("rejects invalid options", () => {
    expect(projectRegistryDaemonPrivateDnsCreate(null as never).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ enabled: "yes" })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ tailnet: " " })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ nodeAddress: "not-an-ip" })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ nodeAddress: "::1" })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ apiBaseUrl: "http://plain/api" })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ upstreamResolvers: [] })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ upstreamResolvers: ["999.1.1.1"] })).success).toBe(
      false,
    )
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ dnsmasqConfigPath: "relative.conf" })).success).toBe(
      false,
    )
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ splitDnsStateDirectory: "relative" })).success).toBe(
      false,
    )
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ filesystem: undefined })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ resolverReload: "now" })).success).toBe(false)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ timer: undefined })).success).toBe(false)
  })
})

describe("projectRegistryDaemonPrivateDnsCreate disabled", () => {
  test("constructs without tailnet or node address while disabled", () => {
    expect(
      projectRegistryDaemonPrivateDnsCreate(optionsCreate({ enabled: false, tailnet: "", nodeAddress: "" })).success,
    ).toBe(true)
    expect(projectRegistryDaemonPrivateDnsCreate(optionsCreate({ tailnet: "" })).success).toBe(false)
  })

  test("stays idle and reports disabled", async () => {
    const stored = filesystemCreate()
    const timer = timerCreate()
    const dnsR = projectRegistryDaemonPrivateDnsCreate(
      optionsCreate({ enabled: false, filesystem: stored.filesystem, timer: timer.timer }),
    )
    expect(dnsR.success).toBe(true)
    if (!dnsR.success) return
    expect(dnsR.data.start().success).toBe(true)
    dnsR.data.projectCreateAfterPersistence(project(["app.wonder1.de"], { visibility: "private" }), { noDns: false })
    await settle()
    const status = dnsR.data.status()
    expect(status.enabled).toBe(false)
    expect(status.pendingProjects).toBe(0)
    expect(status.errors).toEqual([])
    expect(stored.files.size).toBe(0)
    await dnsR.data.shutdown()
    expect(timer.cleared).toBe(0)
  })

  test("honors noDns on create", async () => {
    const stored = filesystemCreate()
    const dnsR = projectRegistryDaemonPrivateDnsCreate(optionsCreate({ filesystem: stored.filesystem }))
    if (!dnsR.success) throw new Error("setup failed")
    expect(dnsR.data.start().success).toBe(true)
    dnsR.data.projectCreateAfterPersistence(project(["app.wonder1.de"], { visibility: "private" }), { noDns: true })
    await settle()
    expect(dnsR.data.status().pendingProjects).toBe(0)
    await dnsR.data.shutdown()
  })
})

describe("projectRegistryDaemonPrivateDnsCreate claims", () => {
  test("excludes cross-zone claims with a claim error and converges valid hosts", async () => {
    const stored = filesystemCreate()
    const timer = timerCreate()
    const calls: string[] = []
    const live = new Map<string, string[]>()
    const { fetch } = splitDnsFetchCreate(live, calls)
    let reloads = 0
    const dnsR = projectRegistryDaemonPrivateDnsCreate(
      optionsCreate({
        filesystem: stored.filesystem,
        timer: timer.timer,
        fetch,
        credentialResolve: async () => createResult("tskey-test"),
        resolverReload: async () => {
          reloads += 1
          return createResult(undefined)
        },
      }),
    )
    if (!dnsR.success) throw new Error("setup failed")
    expect(dnsR.data.start().success).toBe(true)
    dnsR.data.projectCreateAfterPersistence(
      project(["checkout.wonder1.de", "x.david-siewert.com"], { visibility: "private" }),
      { noDns: false },
    )
    await settle(8)
    // Only the claimable host converges; the cross-zone name is refused, never widened.
    expect([...live.entries()]).toEqual([["checkout.wonder1.de", [nodeAddress]]])
    const config = stored.files.get("/etc/project-registry/private-dnsmasq.conf") ?? ""
    expect(config).toContain("host-record=checkout.wonder1.de,100.122.200.114")
    expect(config).not.toContain("x.david-siewert.com")
    expect(reloads).toBe(1)
    const status = dnsR.data.status()
    expect(status.pendingProjects).toBe(0)
    expect(status.errors.map((entry) => entry.operation)).toEqual(["claim"])
    expect(status.errors[0]?.errorMessage).toContain("wonder1.de")
    await dnsR.data.shutdown()
  })

  test("ignores public and disabled routes", async () => {
    const stored = filesystemCreate()
    const calls: string[] = []
    const live = new Map<string, string[]>()
    const { fetch } = splitDnsFetchCreate(live, calls)
    const dnsR = projectRegistryDaemonPrivateDnsCreate(
      optionsCreate({
        filesystem: stored.filesystem,
        fetch,
        credentialResolve: async () => createResult("tskey-test"),
        resolverReload: async () => createResult(undefined),
      }),
    )
    if (!dnsR.success) throw new Error("setup failed")
    expect(dnsR.data.start().success).toBe(true)
    dnsR.data.projectCreateAfterPersistence(project(["public.wonder1.de"], { visibility: "public" }), { noDns: false })
    dnsR.data.projectCreateAfterPersistence(
      project(["disabled.wonder1.de"], { visibility: "private", disabled: true, name: "other" }),
      { noDns: false },
    )
    await settle(8)
    expect(live.size).toBe(0)
    expect(calls.filter((call) => call.startsWith("PATCH")).length).toBe(0)
    await dnsR.data.shutdown()
  })
})

describe("projectRegistryDaemonPrivateDnsCreate credentials", () => {
  test("defers with backoff while the tailnet credential is missing", async () => {
    const stored = filesystemCreate()
    let now = 1_000_000
    const timer = timerCreate()
    const calls: string[] = []
    const live = new Map<string, string[]>()
    const { fetch } = splitDnsFetchCreate(live, calls)
    const dnsR = projectRegistryDaemonPrivateDnsCreate(
      optionsCreate({
        filesystem: stored.filesystem,
        timer: timer.timer,
        fetch,
        clock: () => now,
        credentialResolve: async () => createResult(undefined),
        resolverReload: async () => createResult(undefined),
      }),
    )
    if (!dnsR.success) throw new Error("setup failed")
    expect(dnsR.data.start().success).toBe(true)
    dnsR.data.projectCreateAfterPersistence(project(["app.wonder1.de"], { visibility: "private" }), { noDns: false })
    await settle(8)
    expect(live.size).toBe(0)
    let status = dnsR.data.status()
    expect(status.pendingProjects).toBe(1)
    expect(status.errors.map((entry) => entry.errorMessage)).toEqual(["owner-credential-missing"])
    expect(status.errors[0]?.nextRetryAt).toBe(now + 2_000)
    // The retry deadline is honored: no split-DNS traffic before it lapses.
    expect(calls.length).toBe(0)
    now += 1_001
    timer.tick()
    await settle(8)
    expect(calls.length).toBe(0)
    status = dnsR.data.status()
    expect(status.pendingProjects).toBe(1)
    await dnsR.data.shutdown()
  })
})

describe("projectRegistryDaemonConfigFromEnv private DNS", () => {
  test("is disabled by default until the Phase 1 import enables it", () => {
    const result = projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository" })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.privateDns.enabled).toBe(false)
    expect(result.data.privateDns).toMatchObject({
      apiBaseUrl: "https://api.tailscale.com/api/v2",
      dnsmasqConfigPath: "/etc/project-registry/private-dnsmasq.conf",
      upstreamResolvers: ["1.1.1.1", "8.8.8.8"],
      credentialsDirectory: "/etc/project-registry/tailscale",
    })
  })

  test("reads the enable flag, tailnet, node address, and resolver paths", () => {
    const result = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_PRIVATE_DNS_ENABLED: "true",
      PROJECT_REGISTRY_PRIVATE_DNS_TAILNET: "example.com",
      PROJECT_REGISTRY_PRIVATE_DNS_NODE_ADDRESS: "100.122.200.114",
      PROJECT_REGISTRY_PRIVATE_DNS_API_BASE: "https://tailscale.example.com/api",
      PROJECT_REGISTRY_PRIVATE_DNS_DNSMASQ_CONFIG: "/etc/dnsmasq.d/private.conf",
      PROJECT_REGISTRY_PRIVATE_DNS_RESOLVER_UNIT: "private-dnsmasq",
      PROJECT_REGISTRY_PRIVATE_DNS_UPSTREAMS: "9.9.9.9, 149.112.112.112",
      PROJECT_REGISTRY_PRIVATE_DNS_CREDENTIALS_DIR: "/etc/project-registry/tailscale-custom",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.privateDns).toEqual({
      enabled: true,
      tailnet: "example.com",
      nodeAddress: "100.122.200.114",
      apiBaseUrl: "https://tailscale.example.com/api",
      dnsmasqConfigPath: "/etc/dnsmasq.d/private.conf",
      resolverUnit: "private-dnsmasq",
      upstreamResolvers: ["9.9.9.9", "149.112.112.112"],
      credentialsDirectory: "/etc/project-registry/tailscale-custom",
    })
  })

  test("requires tailnet and node address when enabled, and rejects bad input", () => {
    const missing = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_PRIVATE_DNS_ENABLED: "true",
    })
    expect(missing.success).toBe(false)
    const badAddress = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_PRIVATE_DNS_ENABLED: "true",
      PROJECT_REGISTRY_PRIVATE_DNS_TAILNET: "example.com",
      PROJECT_REGISTRY_PRIVATE_DNS_NODE_ADDRESS: "not-an-ip",
    })
    expect(badAddress.success).toBe(false)
    const badUpstreams = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_PRIVATE_DNS_UPSTREAMS: "not-an-ip",
    })
    expect(badUpstreams.success).toBe(false)
  })
})
