import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { Project } from "../project/Project.js"
import type { DevLeaseTracking } from "./DevLeaseTracking.js"
import type { DevProcessRunner } from "./DevProcessRunner.js"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"
import type { DevLeaseTrackingState } from "./devLeaseTrackingState.js"
import { type DevLeaseUpUseCaseOptions, devLeaseUpUseCase } from "./devLeaseUpUseCase.js"

type RunnerCall = { command: string; args: readonly string[]; input: string }

function trackingCreate(initial: DevLeaseRecord[] = []): DevLeaseTracking & { state: DevLeaseTrackingState } {
  const value = {
    state: { version: 1 as const, leases: initial },
    read: async () => createResult(value.state),
    write: async (next: DevLeaseTrackingState) => {
      value.state = next
      return createResult(undefined)
    },
  }
  return value
}

function runnerCreate(
  calls: RunnerCall[],
  behavior: (call: RunnerCall) => { exitCode: number; stdout: string; stderr: string } = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
): DevProcessRunner {
  return async (command, args, input) => {
    calls.push({ command, args, input })
    return createResult(behavior({ command, args, input }))
  }
}

function filesystemCreate(): DevProjectFilesystem {
  return {
    readFile: async (path) => {
      if (path.endsWith("package.json")) return JSON.stringify({ name: "x", scripts: { dev: "vite" } })
      throw new Error(`ENOENT: ${path}`)
    },
    realpath: async (path) => path,
    stat: async () => ({ isDirectory: () => true }),
  }
}

function clockCreate(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let now = start
  return { now: () => now, advance: (ms) => void (now += ms) }
}

type Harness = {
  calls: RunnerCall[]
  tracking: DevLeaseTracking & { state: DevLeaseTrackingState }
  clock: { now: () => number; advance: (ms: number) => void }
  regenerations: number
  fetchCalls: number
  options: (overrides?: Partial<DevLeaseUpUseCaseOptions>) => DevLeaseUpUseCaseOptions
}

function harnessCreate(
  options: {
    leases?: DevLeaseRecord[]
    runnerBehavior?: (call: RunnerCall) => { exitCode: number; stdout: string; stderr: string }
    fetchBehavior?: () => Promise<Response>
    now?: number
    regenerateFailure?: string
  } = {},
): Harness {
  const calls: RunnerCall[] = []
  const tracking = trackingCreate(options.leases ?? [])
  const clock = clockCreate(options.now)
  const fetchBehavior =
    options.fetchBehavior ??
    (async () => {
      harness.fetchCalls += 1
      return new Response("ok", { status: 200 })
    })
  const harness: Harness = {
    calls,
    tracking,
    clock,
    regenerations: 0,
    fetchCalls: 0,
    options: (overrides = {}) => ({
      user: "tim",
      name: "akademie",
      projects: [] as Project[],
      portRange: { from: 4400, to: 4402 },
      tracking,
      runner: runnerCreate(calls, options.runnerBehavior),
      userResolve: async () => createResult({ uid: 1002 }),
      projectsRoot: "/projects",
      commandFilesystem: filesystemCreate(),
      pathValue: "/usr/bin",
      fetch: fetchBehavior,
      clock: clock.now,
      wait: async (ms: number) => void clock.advance(ms),
      regenerate: async () => {
        harness.regenerations += 1
        return options.regenerateFailure === undefined
          ? createResult({ revision: "r", changed: true, applied: true, attempts: 1 })
          : { success: false as const, op: "test", errorMessage: options.regenerateFailure }
      },
      ...overrides,
    }),
  }
  return harness
}

function projectRow(services: { id: string; dev?: { command: string } }[]): Project {
  return {
    schemaVersion: 2,
    owner: "tim",
    name: "akademie",
    order: 0,
    labels: {},
    services: services.map((service) => ({ units: [], caddy: null, ownership: "registry" as const, ...service })),
  }
}

function leaseCreate(overrides: Partial<DevLeaseRecord> = {}): DevLeaseRecord {
  return {
    projectKey: { owner: "tim", name: "akademie" },
    user: "tim",
    port: 4400,
    unit: "dev-tim-akademie.service",
    hostname: "tim-akademie.wonder1.de",
    state: "active",
    ttlMs: 14_400_000,
    lastSeenAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe("devLeaseUpUseCase", () => {
  test("starts the unit with the systemd argv shape, persists the active lease, and regenerates", async () => {
    const harness = harnessCreate()
    const result = await devLeaseUpUseCase(harness.options())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({
      hostname: "tim-akademie.wonder1.de",
      port: 4400,
      unit: "dev-tim-akademie.service",
      state: "active",
      user: "tim",
    })
    expect(harness.tracking.state.leases).toHaveLength(1)
    expect(harness.tracking.state.leases[0]).toMatchObject({ state: "active" })
    expect(harness.regenerations).toBe(1)
    const spawn = harness.calls.find((call) => call.command === "systemd-run")
    expect(spawn).toBeDefined()
    expect(spawn!.args).toContain("--property=User=tim")
    expect(spawn!.args).toContain("--property=Slice=user-1002.slice")
    expect(spawn!.args).toContain("--working-directory=/projects/akademie")
    expect(spawn!.args).toContain("--setenv=PORT=4400")
    expect(spawn!.args).toContain("--setenv=HOST=127.0.0.1")
    expect(spawn!.args).toContain("--setenv=DEV_URL=https://tim-akademie.wonder1.de")
    expect(spawn!.args).toContain("--setenv=__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=tim-akademie.wonder1.de")
    // `"dev": "vite"` runs the project-local vite binary on the lease port.
    expect(spawn!.args.slice(spawn!.args.indexOf("--") + 1)).toEqual([
      "/projects/akademie/node_modules/.bin/vite",
      "--port",
      "4400",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ])
  })

  test("an idempotent up for the same lease touches lastSeenAt without spawning or regenerating", async () => {
    const harness = harnessCreate({
      now: 1_700_000_001_000,
      leases: [leaseCreate({ lastSeenAt: 1_700_000_000_000 })],
      runnerBehavior: (call) =>
        call.command === "systemctl"
          ? { exitCode: 0, stdout: "active\n", stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" },
    })
    const result = await devLeaseUpUseCase(harness.options())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.lastSeenAt).toBe(1_700_000_001_000)
    expect(result.data.port).toBe(4400)
    expect(harness.calls.some((call) => call.command === "systemd-run")).toBe(false)
    expect(harness.regenerations).toBe(0)
    expect(harness.tracking.state.leases).toHaveLength(1)
  })

  test("a spawn failure stops the unit, deletes the lease, and frees the port", async () => {
    const harness = harnessCreate({
      runnerBehavior: (call) =>
        call.command === "systemd-run"
          ? { exitCode: 1, stdout: "", stderr: "Failed" }
          : { exitCode: 0, stdout: "", stderr: "" },
    })
    const result = await devLeaseUpUseCase(harness.options())

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("caddy.unavailable")
    expect(harness.tracking.state.leases).toEqual([])
    expect(harness.calls).toContainEqual({
      command: "systemctl",
      args: ["stop", "dev-tim-akademie.service"],
      input: "",
    })
    expect(harness.regenerations).toBe(0)
  })

  test("a health timeout stops the unit and deletes the lease", async () => {
    const harness = harnessCreate({
      now: 0,
      fetchBehavior: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    const result = await devLeaseUpUseCase(
      harness.options({
        healthTimeoutMs: 2000,
        healthIntervalMs: 500,
        fetch: async () => {
          throw new Error("ECONNREFUSED")
        },
      }),
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("caddy.unavailable")
    expect(result.errorMessage).toBe("dev server health check timed out")
    expect(harness.tracking.state.leases).toEqual([])
    expect(harness.calls).toContainEqual({
      command: "systemctl",
      args: ["stop", "dev-tim-akademie.service"],
      input: "",
    })
    expect(harness.regenerations).toBe(0)
  })

  test("three concurrent leases for one user get distinct ports", async () => {
    const harness = harnessCreate()
    const ports: number[] = []
    for (const name of ["akademie", "werkstatt", "intranet"]) {
      const result = await devLeaseUpUseCase(harness.options({ name }))
      expect(result.success).toBe(true)
      if (!result.success) return
      ports.push(result.data.port)
    }

    expect(new Set(ports).size).toBe(3)
    expect(ports).toEqual([4400, 4401, 4402])
  })

  test("a missing project directory fails without spawning", async () => {
    const harness = harnessCreate()
    const failingFilesystem: DevProjectFilesystem = {
      readFile: async () => {
        throw new Error("ENOENT")
      },
      realpath: async () => {
        throw new Error("ENOENT")
      },
      stat: async () => ({ isDirectory: () => true }),
    }
    const result = await devLeaseUpUseCase(harness.options({ commandFilesystem: failingFilesystem }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.not-found")
    expect(harness.calls).toEqual([])
    expect(harness.tracking.state.leases).toEqual([])
  })

  test("a missing dev script fails without spawning", async () => {
    const harness = harnessCreate()
    const filesystem: DevProjectFilesystem = {
      readFile: async () => JSON.stringify({ name: "akademie" }),
      realpath: async (path) => path,
      stat: async () => ({ isDirectory: () => true }),
    }
    const result = await devLeaseUpUseCase(harness.options({ commandFilesystem: filesystem }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("request.invalid")
    expect(harness.calls).toEqual([])
    expect(harness.tracking.state.leases).toEqual([])
  })

  test("a regenerate failure stops the unit and deletes the lease", async () => {
    const harness = harnessCreate({ regenerateFailure: "Caddy admin is down" })
    const result = await devLeaseUpUseCase(harness.options())

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errorMessage).toBe("Caddy admin is down")
    expect(harness.tracking.state.leases).toEqual([])
    expect(harness.calls).toContainEqual({
      command: "systemctl",
      args: ["stop", "dev-tim-akademie.service"],
      input: "",
    })
  })

  test("a row dev.command beats the package.json dev script with substituted placeholders", async () => {
    const harness = harnessCreate()
    const projects: Project[] = [
      projectRow([{ id: "web", dev: { command: "bun run vite --host {host} --port {port}" } }]),
    ]
    const result = await devLeaseUpUseCase(harness.options({ projects }))

    expect(result.success).toBe(true)
    if (!result.success) return
    const spawn = harness.calls.find((call) => call.command === "systemd-run")
    expect(spawn).toBeDefined()
    expect(spawn!.args.slice(-6)).toEqual(["run", "vite", "--host", "127.0.0.1", "--port", "4400"])
    expect(spawn!.args).toContain("--setenv=PORT=4400")
  })

  test("an explicit argv override still beats the row dev.command", async () => {
    const harness = harnessCreate()
    const projects: Project[] = [projectRow([{ id: "web", dev: { command: "bun run vite --port {port}" } }])]
    const result = await devLeaseUpUseCase(
      harness.options({ projects, command: { command: "node", args: ["./server.mjs"] } }),
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    const spawn = harness.calls.find((call) => call.command === "systemd-run")
    expect(spawn!.args.slice(-2)).toEqual(["node", "./server.mjs"])
  })

  test("a service id selects its own dev.command among several services", async () => {
    const harness = harnessCreate()
    const projects: Project[] = [
      projectRow([
        { id: "web", dev: { command: "bun run vite --port {port}" } },
        { id: "api", dev: { command: "bun run ./api.ts --port {port}" } },
      ]),
    ]
    const result = await devLeaseUpUseCase(harness.options({ projects, serviceId: "api" }))

    expect(result.success).toBe(true)
    if (!result.success) return
    const spawn = harness.calls.find((call) => call.command === "systemd-run")
    expect(spawn!.args.slice(-4)).toEqual(["run", "./api.ts", "--port", "4400"])
  })

  test("several services without a service id use the single service that declares dev", async () => {
    const harness = harnessCreate()
    const projects: Project[] = [
      projectRow([{ id: "web" }, { id: "api", dev: { command: "bun run ./api.ts --port {port}" } }, { id: "convex" }]),
    ]
    const result = await devLeaseUpUseCase(harness.options({ projects }))

    expect(result.success).toBe(true)
    if (!result.success) return
    const spawn = harness.calls.find((call) => call.command === "systemd-run")
    expect(spawn!.args.slice(-4)).toEqual(["run", "./api.ts", "--port", "4400"])
  })

  test("several services that all declare dev fall back to the package.json dev script", async () => {
    const harness = harnessCreate()
    const projects: Project[] = [
      projectRow([
        { id: "web", dev: { command: "bun run vite --port {port}" } },
        { id: "api", dev: { command: "bun run ./api.ts --port {port}" } },
      ]),
    ]
    const result = await devLeaseUpUseCase(harness.options({ projects }))

    expect(result.success).toBe(true)
    if (!result.success) return
    const spawn = harness.calls.find((call) => call.command === "systemd-run")
    expect(spawn!.args.at(-6)).toBe("/projects/akademie/node_modules/.bin/vite")
  })

  test("an unknown service id is not found and spawns nothing", async () => {
    const harness = harnessCreate()
    const projects: Project[] = [projectRow([{ id: "web" }])]
    const result = await devLeaseUpUseCase(harness.options({ projects, serviceId: "api" }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.not-found")
    expect(harness.calls).toEqual([])
  })

  test("a lease for another service of the same project is a conflict", async () => {
    const harness = harnessCreate({ leases: [leaseCreate({ serviceId: "web" })] })
    const result = await devLeaseUpUseCase(harness.options({ serviceId: "api" }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("projects.conflict")
  })

  test("no registry row is needed: the directory under an allowed root is enough", async () => {
    const harness = harnessCreate()
    const result = await devLeaseUpUseCase(
      harness.options({
        projectsRoot: undefined,
        roots: [{ path: "/projects", users: ["leo", "david", "tim", "mit"] }],
      }),
    )

    expect(result.success).toBe(true)
    const spawn = harness.calls.find((call) => call.command === "systemd-run")
    expect(spawn!.args).toContain("--working-directory=/projects/akademie")
  })

  test("a caller missing from every root allowlist is forbidden before anything spawns", async () => {
    const harness = harnessCreate()
    const result = await devLeaseUpUseCase(
      harness.options({ projectsRoot: undefined, roots: [{ path: "/projects", users: ["leo", "david"] }] }),
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.forbidden")
    expect(harness.calls).toEqual([])
    expect(harness.tracking.state.leases).toEqual([])
  })

  test("the default health wait allows 90s for a cold dev server", async () => {
    let attempts = 0
    const harness = harnessCreate({
      fetchBehavior: async () => {
        attempts += 1
        if (harness.clock.now() - 1_700_000_000_000 < 80_000) throw new Error("ECONNREFUSED")
        return new Response("ok")
      },
    })
    const result = await devLeaseUpUseCase(harness.options({ healthIntervalMs: 5_000 }))

    expect(result.success).toBe(true)
    expect(attempts).toBeGreaterThan(1)
  })

  test("neither row nor manifest reports the project in the missing-contract error", async () => {
    const harness = harnessCreate()
    const filesystem: DevProjectFilesystem = {
      readFile: async () => JSON.stringify({ name: "akademie" }),
      realpath: async (path) => path,
      stat: async () => ({ isDirectory: () => true }),
    }
    const projects: Project[] = [projectRow([])]
    const result = await devLeaseUpUseCase(harness.options({ projects, commandFilesystem: filesystem }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("request.invalid")
    expect(result.errorMessage).toBe(
      "dev command for project tim/akademie is not configured (dev package.json has no dev script)",
    )
    expect(harness.calls).toEqual([])
  })

  test("a stale lease with a dead unit is replaced instead of touched", async () => {
    const harness = harnessCreate({
      now: 1_700_000_001_000,
      leases: [leaseCreate({ lastSeenAt: 1_700_000_000_000 })],
      runnerBehavior: (call) => {
        if (call.command === "systemctl" && call.args[0] === "is-active") {
          return { exitCode: 3, stdout: "inactive\n", stderr: "" }
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    const result = await devLeaseUpUseCase(harness.options())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.state).toBe("active")
    expect(harness.tracking.state.leases).toHaveLength(1)
    expect(harness.regenerations).toBe(1)
    expect(harness.calls.some((call) => call.command === "systemd-run")).toBe(true)
  })
})
