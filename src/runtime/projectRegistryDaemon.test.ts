import { describe, expect, test } from "bun:test"
import { chmod as fsChmod, chown as fsChown, lstat as fsLstat, mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { createResult, createResultError } from "#result"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"
import type { ProjectRegistryDaemonFilesystem } from "./ProjectRegistryDaemonFilesystem.js"
import type { ProjectRegistryDaemonMappedUser } from "./ProjectRegistryDaemonMappedUser.js"
import type { ProjectRegistryDaemonServer } from "./ProjectRegistryDaemonServer.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import type { ProjectRegistryDaemonSignals } from "./ProjectRegistryDaemonSignals.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"
import { projectRegistryDaemonCreate } from "./projectRegistryDaemonCreate.js"
import { projectRegistryDaemonFilesystemDefault } from "./projectRegistryDaemonFilesystemDefault.js"

function config(overrides: Partial<ProjectRegistryDaemonConfig> = {}): ProjectRegistryDaemonConfig {
  const result = projectRegistryDaemonConfigValidate({ repositoryPath: "/tmp/project-registry-test", ...overrides })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

function repository(ready = true): ProjectRepository {
  const readiness = () =>
    Promise.resolve(
      createResult({ ready, clean: ready, revision: ready ? "revision" : "", reason: ready ? undefined : "dirty" }),
    )
  return {
    read: () => Promise.resolve(createResult({ projects: [], revision: "revision" })),
    get: async () => createResultError("test", "not found"),
    create: async () => createResultError("test", "not implemented"),
    edit: async () => createResultError("test", "not implemented"),
    delete: async () => createResultError("test", "not implemented"),
    history: async () => createResult([]),
    readiness,
    recover: readiness,
  }
}

function caddyApplication(pending = false): CaddyApplication & { starts: number; stops: number } {
  const value = {
    starts: 0,
    stops: 0,
    start: async () => createResult({ revision: "revision", changed: true, applied: true, attempts: 1 }),
    startup: async () => {
      value.starts += 1
      return createResult({ revision: "revision", changed: true, applied: true, attempts: 1 })
    },
    regenerate: async () => createResult({ revision: "revision", changed: true, applied: true, attempts: 1 }),
    projectChange: async () => createResult({ revision: "revision", changed: false, applied: true, attempts: 0 }),
    status: () => ({ pending }),
    stop: async () => {
      value.stops += 1
    },
  }
  return value
}

function filesystemCreate(): {
  filesystem: ProjectRegistryDaemonFilesystem
  entries: Map<string, ProjectRegistryDaemonFileStat>
  modes: Array<{ path: string; mode: number }>
  owners: Array<{ path: string; uid: number; gid: number }>
} {
  const entries = new Map<string, ProjectRegistryDaemonFileStat>([
    ["/", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
    ["/run", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
  ])
  const modes: Array<{ path: string; mode: number }> = []
  const owners: Array<{ path: string; uid: number; gid: number }> = []
  const filesystem: ProjectRegistryDaemonFilesystem = {
    async lstat(path) {
      return entries.get(path)
    },
    async realpath(path) {
      return path
    },
    async mkdir(path) {
      entries.set(path, { type: "directory", mode: 0o755, uid: 0, gid: 0 })
    },
    async readdir(path) {
      const prefix = `${path}/`
      return [...entries.keys()]
        .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"))
        .map((entry) => entry.slice(prefix.length))
    },
    async chmod(path, mode) {
      const entry = entries.get(path)
      if (entry === undefined) throw new Error("missing path")
      entry.mode = mode
      modes.push({ path, mode })
    },
    async chown(path, uid, gid) {
      const entry = entries.get(path)
      if (entry === undefined) throw new Error("missing path")
      entry.uid = uid
      entry.gid = gid
      owners.push({ path, uid, gid })
    },
    async unlink(path) {
      entries.delete(path)
    },
  }
  return { filesystem, entries, modes, owners }
}

function serverFactoryCreate(entries: Map<string, ProjectRegistryDaemonFileStat>): {
  factory: ProjectRegistryDaemonServerFactory
  contexts: string[]
  stops(): number
} {
  const contexts: string[] = []
  let stops = 0
  const factory: ProjectRegistryDaemonServerFactory = (options) => {
    if (options.unix !== undefined) {
      entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
      contexts.push("unix")
    } else {
      contexts.push("http")
    }
    const server: ProjectRegistryDaemonServer = {
      stop: () => {
        stops += 1
      },
    }
    return server
  }
  return { factory, contexts, stops: () => stops }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function signalsCreate(): {
  signals: ProjectRegistryDaemonSignals
  listeners: Record<"SIGINT" | "SIGTERM", Array<() => void>>
} {
  const listeners = { SIGINT: [], SIGTERM: [] } as Record<"SIGINT" | "SIGTERM", Array<() => void>>
  return {
    listeners,
    signals: {
      on(signal, listener) {
        listeners[signal].push(listener)
        return () => {
          const index = listeners[signal].indexOf(listener)
          if (index >= 0) listeners[signal].splice(index, 1)
        }
      },
    },
  }
}

describe("projectRegistryDaemonConfigValidate", () => {
  test("requires an absolute repository and a loopback web listener", () => {
    expect(projectRegistryDaemonConfigValidate({ repositoryPath: "relative" }).success).toBe(false)
    expect(
      projectRegistryDaemonConfigValidate({
        repositoryPath: "/tmp/repository",
        webListener: { hostname: "0.0.0.0", port: 8080 },
      }).success,
    ).toBe(false)
  })

  test("rejects reversed ports and admin credentials", () => {
    expect(
      projectRegistryDaemonConfigValidate({ repositoryPath: "/tmp/repository", portRange: { from: 4000, to: 3000 } })
        .success,
    ).toBe(false)
    expect(
      projectRegistryDaemonConfigValidate({ repositoryPath: "/tmp/repository", caddyAdminUrl: "http://u:p@localhost" })
        .success,
    ).toBe(false)
  })

  test("returns errors for malformed config and accessor inputs", () => {
    const throwingConfig = new Proxy(
      {},
      {
        get: () => {
          throw new Error("config accessor failed")
        },
      },
    )
    expect(() => projectRegistryDaemonConfigValidate(throwingConfig)).not.toThrow()
    expect(projectRegistryDaemonConfigValidate(throwingConfig).success).toBe(false)
    expect(
      projectRegistryDaemonConfigValidate({ repositoryPath: "/tmp/repository", mappedUsers: ["alice", "alice"] })
        .success,
    ).toBe(false)
  })

  test("rejects malformed environment values without throwing", () => {
    expect(() => projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: 12 } as never)).not.toThrow()
    expect(projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: 12 } as never).success).toBe(false)
    const throwingEnvironment = new Proxy(
      {},
      {
        get: () => {
          throw new Error("environment accessor failed")
        },
      },
    )
    expect(() => projectRegistryDaemonConfigFromEnv(throwingEnvironment)).not.toThrow()
    expect(projectRegistryDaemonConfigFromEnv(throwingEnvironment).success).toBe(false)
  })
})

describe("projectRegistryDaemonCreate", () => {
  test("starts shared HTTP and per-user Unix listeners with private ownership", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const caddy = caddyApplication()
    const users: ProjectRegistryDaemonMappedUser[] = [{ username: "alice", uid: 1001, gid: 1002 }]
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice"], socketDirectory: "/run/project-registry" }),
      repository: repository(),
      caddyApplication: caddy,
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: { isRoot: () => true, userResolve: async () => createResult(users[0] as ProjectRegistryDaemonMappedUser) },
      requireRoot: true,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    const startR = await daemonR.data.start()
    expect(startR.success).toBe(true)
    expect(fakeServers.contexts).toEqual(["http", "unix"])
    expect(fakeFilesystem.entries.get("/run/project-registry/alice.sock")).toEqual({
      type: "socket",
      mode: 0o600,
      uid: 1001,
      gid: 1002,
    })
    const readinessR = await daemonR.data.readiness()
    expect(readinessR.success && readinessR.data.ready).toBe(true)
    await daemonR.data.shutdown()
    expect(fakeFilesystem.entries.has("/run/project-registry/alice.sock")).toBe(false)
    expect(caddy.stops).toBe(1)
    await daemonR.data.shutdown()
    expect(caddy.stops).toBe(1)
  })

  test("keeps readiness false for a dirty repository and missing mapped users", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["missing"] }),
      repository: repository(false),
      caddyApplication: caddyApplication(true),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: {
        isRoot: () => true,
        userResolve: async () => createResultError("userResolve", "Linux user missing does not exist"),
      },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)
    const readinessR = await daemonR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (!readinessR.success) return
    expect(readinessR.data.ready).toBe(false)
    expect(readinessR.data.repositoryReady).toBe(false)
    expect(readinessR.data.socketsReady).toBe(false)
    await daemonR.data.shutdown()
  })

  test("refuses an existing non-socket path and non-root startup", async () => {
    const fakeFilesystem = filesystemCreate()
    fakeFilesystem.entries.set("/run/project-registry", { type: "directory", mode: 0o755, uid: 0, gid: 0 })
    fakeFilesystem.entries.set("/run/project-registry/alice.sock", { type: "file", mode: 0o644, uid: 0, gid: 0 })
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: { isRoot: () => false, userResolve: async () => createResult({ username: "alice", uid: 1, gid: 1 }) },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(false)
    expect(daemonR.data.healthLive().live).toBe(false)
  })

  test("refreshes dynamic mappings, including UID changes", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    let mappings: ProjectRegistryDaemonMappedUser[] = [
      { username: "alice", uid: 1001, gid: 1002 },
      { username: "bob", uid: 1003, gid: 1004 },
    ]
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice", "bob"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      mappedUsersResolve: () => createResult(mappings),
      posix: {
        isRoot: () => true,
        userResolve: async () => createResult(mappings[0] as ProjectRegistryDaemonMappedUser),
      },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    mappings = [
      { username: "alice", uid: 2001, gid: 2002 },
      { username: "bob", uid: 3001, gid: 3002 },
    ]
    const changedR = await daemonR.data.refreshSockets()
    expect(changedR.success).toBe(true)
    expect(fakeFilesystem.entries.get("/run/project-registry/alice.sock")).toEqual({
      type: "socket",
      mode: 0o600,
      uid: 2001,
      gid: 2002,
    })
    expect(fakeFilesystem.entries.get("/run/project-registry/bob.sock")).toEqual({
      type: "socket",
      mode: 0o600,
      uid: 3001,
      gid: 3002,
    })
    await daemonR.data.shutdown()
  })

  test("keeps valid sockets when one mapped socket fails to start", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice", "bob"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: (options) => {
        if (options.unix?.endsWith("bob.sock")) throw new Error("socket setup failed")
        return fakeServers.factory(options)
      },
      mappedUsersResolve: () =>
        createResult([
          { username: "alice", uid: 1001, gid: 1002 },
          { username: "bob", uid: 1003, gid: 1004 },
        ]),
      posix: { isRoot: () => true, userResolve: async () => createResult({ username: "alice", uid: 1, gid: 1 }) },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    const startR = await daemonR.data.start()
    expect(startR.success).toBe(false)
    expect(fakeFilesystem.entries.has("/run/project-registry/alice.sock")).toBe(false)
    await daemonR.data.shutdown()
  })

  test("rejects a socket directory symlink", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: {
        ...fakeFilesystem.filesystem,
        realpath: async (path) => (path === "/run/project-registry" ? "/tmp/target" : path),
      },
      serverFactory: fakeServers.factory,
      posix: { isRoot: () => true, userResolve: async () => createResult({ username: "alice", uid: 1, gid: 1 }) },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(false)
    expect(fakeFilesystem.entries.has("/run/project-registry/alice.sock")).toBe(false)
    await daemonR.data.shutdown()
  })

  test("rejects malformed mapped-user and POSIX results", async () => {
    const malformedMappedUsers = projectRegistryDaemonCreate({
      config: config(),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: filesystemCreate().filesystem,
      mappedUsersResolve: () => ({ success: true, data: { username: "alice" } }) as never,
      requireRoot: false,
    })
    expect(malformedMappedUsers.success).toBe(true)
    if (!malformedMappedUsers.success) return
    expect((await malformedMappedUsers.data.start()).success).toBe(false)
    await malformedMappedUsers.data.shutdown()

    const malformedPosix = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: filesystemCreate().filesystem,
      posix: {
        isRoot: () => true,
        userResolve: async () => ({ success: true, data: { username: "alice", uid: 0x1_0000_0000, gid: 1 } }) as never,
      },
      requireRoot: true,
    })
    expect(malformedPosix.success).toBe(true)
    if (!malformedPosix.success) return
    expect((await malformedPosix.data.start()).success).toBe(false)
    await malformedPosix.data.shutdown()
  })

  test("retries failed socket cleanup before applying a UID change", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    let unlinkFailures = 1
    const filesystem: ProjectRegistryDaemonFilesystem = {
      ...fakeFilesystem.filesystem,
      async unlink(path) {
        if (unlinkFailures > 0) {
          unlinkFailures -= 1
          throw new Error("unlink failed")
        }
        await fakeFilesystem.filesystem.unlink(path)
      },
    }
    let mapping: ProjectRegistryDaemonMappedUser = { username: "alice", uid: 1001, gid: 1002 }
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem,
      serverFactory: fakeServers.factory,
      mappedUsersResolve: () => createResult([mapping]),
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)
    mapping = { username: "alice", uid: 2001, gid: 2002 }
    expect((await daemonR.data.refreshSockets()).success).toBe(false)
    expect(fakeFilesystem.entries.get("/run/project-registry/alice.sock")?.uid).toBe(1001)
    expect((await daemonR.data.refreshSockets()).success).toBe(true)
    expect(fakeFilesystem.entries.get("/run/project-registry/alice.sock")).toEqual({
      type: "socket",
      mode: 0o600,
      uid: 2001,
      gid: 2002,
    })
    await daemonR.data.shutdown()
  })

  test("installs signals before a deferred HTTP factory and stops a late server", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeSignals = signalsCreate()
    const serverDeferred = deferred<ProjectRegistryDaemonServer>()
    const daemonR = projectRegistryDaemonCreate({
      config: config({ shutdownTimeoutMs: 100 }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      signals: fakeSignals.signals,
      serverFactory: (options) => {
        if (options.unix !== undefined) return { stop: () => undefined }
        return serverDeferred.promise
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    const startPromise = daemonR.data.start()
    await Promise.resolve()
    expect(fakeSignals.listeners.SIGINT).toHaveLength(1)
    expect(fakeSignals.listeners.SIGTERM).toHaveLength(1)

    const terminationPromise = daemonR.data.termination()
    const shutdownPromise = daemonR.data.shutdown()
    const lateServer: ProjectRegistryDaemonServer = { stop: () => undefined }
    serverDeferred.resolve(lateServer)
    expect((await startPromise).success).toBe(false)
    expect((await shutdownPromise).success).toBe(true)
    expect(await terminationPromise).toEqual(await shutdownPromise)
    expect(daemonR.data.healthLive().live).toBe(false)
    expect(fakeSignals.listeners.SIGINT).toHaveLength(0)
    expect(fakeSignals.listeners.SIGTERM).toHaveLength(0)
  })

  test("rolls back every resource after a Caddy startup failure", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    let stops = 0
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice"] }),
      repository: repository(),
      caddyApplication: {
        start: async () => createResultError("caddy", "startup failed"),
        startup: async () => createResultError("caddy", "startup failed"),
        regenerate: async () => createResultError("caddy", "not started"),
        projectChange: async () => createResultError("caddy", "not started"),
        status: () => ({ pending: false }),
        stop: async () => {
          stops += 1
        },
      },
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: { isRoot: () => true, userResolve: async () => createResult({ username: "alice", uid: 1, gid: 1 }) },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(false)
    expect(daemonR.data.healthLive().live).toBe(false)
    expect(fakeFilesystem.entries.has("/run/project-registry/alice.sock")).toBe(false)
    expect(fakeServers.contexts).toEqual(["http", "unix"])
    expect(fakeServers.stops()).toBe(2)
    expect(stops).toBe(1)
    const readinessR = await daemonR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (readinessR.success) expect(readinessR.data.ready).toBe(false)
  })

  test("keeps readiness false for a Caddy status error with no pending work", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const caddy = caddyApplication()
    caddy.status = () => ({ pending: false, error: "secret caddy error" })
    const daemonR = projectRegistryDaemonCreate({
      config: config(),
      repository: repository(),
      caddyApplication: caddy,
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(true)
    const readinessR = await daemonR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (!readinessR.success) return
    expect(readinessR.data).toMatchObject({ ready: false, caddyReady: false, reason: "Caddy application is not ready" })
    expect(readinessR.data.reason).not.toContain("secret")
    await daemonR.data.shutdown()
  })

  test("waits for an in-flight Git operation before normal shutdown", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const readDeferred = deferred<ReturnType<typeof createResult>>()
    const testRepository = repository()
    testRepository.read = () => readDeferred.promise as never
    const daemonR = projectRegistryDaemonCreate({
      config: config({ shutdownTimeoutMs: 1000 }),
      repository: testRepository,
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    const readPromise = daemonR.data.repository.read()
    await Promise.resolve()
    let shutdownDone = false
    const shutdownPromise = daemonR.data.shutdown().then(() => {
      shutdownDone = true
    })
    await Promise.resolve()
    expect(shutdownDone).toBe(false)
    readDeferred.resolve(createResult({ projects: [], revision: "revision" }) as never)
    await readPromise
    await shutdownPromise
    expect(shutdownDone).toBe(true)
  })

  test("bounds Caddy shutdown and still closes the listener", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const caddyStopDeferred = deferred<void>()
    const caddy = caddyApplication()
    caddy.stop = () => caddyStopDeferred.promise
    const daemonR = projectRegistryDaemonCreate({
      config: config({ shutdownTimeoutMs: 5 }),
      repository: repository(),
      caddyApplication: caddy,
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    const shutdownR = await daemonR.data.shutdown()
    expect(shutdownR).toEqual({
      success: false,
      op: "projectRegistryDaemonShutdown",
      errorMessage: "daemon shutdown degraded",
    })
    expect(daemonR.data.healthLive().live).toBe(false)
    expect(fakeServers.stops()).toBe(1)
    caddyStopDeferred.resolve(undefined)
  })

  test("shares signal-triggered shutdown and removes signal handlers once", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const fakeSignals = signalsCreate()
    const daemonR = projectRegistryDaemonCreate({
      config: config(),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      signals: fakeSignals.signals,
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    const first = fakeSignals.listeners.SIGTERM[0]
    const second = fakeSignals.listeners.SIGINT[0]
    first?.()
    second?.()
    expect(await daemonR.data.shutdown()).toEqual(await daemonR.data.shutdown())
    expect(fakeSignals.listeners.SIGTERM).toHaveLength(0)
    expect(fakeSignals.listeners.SIGINT).toHaveLength(0)
  })

  test("retries a failed web listener stop on the next shutdown", async () => {
    const fakeFilesystem = filesystemCreate()
    let stops = 0
    const daemonR = projectRegistryDaemonCreate({
      config: config(),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: (options) => {
        if (options.unix !== undefined) return { stop: () => undefined }
        return {
          stop: () => {
            stops += 1
            if (stops === 1) throw new Error("web stop failed")
          },
        }
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(true)
    expect((await daemonR.data.shutdown()).success).toBe(false)
    expect(stops).toBe(1)
    expect((await daemonR.data.shutdown()).success).toBe(true)
    expect(stops).toBe(2)
  })

  test("retries a failed Caddy stop on the next shutdown", async () => {
    const caddy = caddyApplication()
    let stops = 0
    caddy.stop = async () => {
      stops += 1
      if (stops === 1) throw new Error("Caddy stop failed")
    }
    const daemonR = projectRegistryDaemonCreate({
      config: config(),
      repository: repository(),
      caddyApplication: caddy,
      filesystem: filesystemCreate().filesystem,
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(true)
    expect((await daemonR.data.shutdown()).success).toBe(false)
    expect(stops).toBe(1)
    expect((await daemonR.data.shutdown()).success).toBe(true)
    expect(stops).toBe(2)
  })

  test("retains and retries a late server returned during shutdown", async () => {
    const fakeFilesystem = filesystemCreate()
    const bobFactoryStarted = deferred<void>()
    const bobServerDeferred = deferred<ProjectRegistryDaemonServer>()
    let bobAvailable = false
    let bobStops = 0
    const alice: ProjectRegistryDaemonMappedUser = { username: "alice", uid: 1001, gid: 1002 }
    const bob: ProjectRegistryDaemonMappedUser = { username: "bob", uid: 1003, gid: 1004 }
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice", "bob"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      posix: {
        isRoot: () => true,
        userResolve: async (username) => {
          if (username === "alice") return createResult(alice)
          if (bobAvailable) return createResult(bob)
          return createResultError("userResolve", "Linux user bob does not exist")
        },
      },
      serverFactory: (options) => {
        if (options.unix !== undefined) {
          fakeFilesystem.entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
        }
        if (options.unix?.endsWith("bob.sock")) {
          bobFactoryStarted.resolve()
          return bobServerDeferred.promise
        }
        return { stop: () => undefined }
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(true)
    bobAvailable = true
    const refreshPromise = daemonR.data.refreshSockets()
    await bobFactoryStarted.promise
    const shutdownPromise = daemonR.data.shutdown()
    bobServerDeferred.resolve({
      stop: () => {
        bobStops += 1
        if (bobStops === 1) throw new Error("late server stop failed")
      },
    })
    await refreshPromise
    expect((await shutdownPromise).success).toBe(false)
    expect(bobStops).toBe(2)
    expect(fakeFilesystem.entries.has("/run/project-registry/bob.sock")).toBe(false)
    expect((await daemonR.data.shutdown()).success).toBe(true)
    expect(bobStops).toBe(2)
  })

  test("bounds startup rollback while continuing listener cleanup", async () => {
    const fakeFilesystem = filesystemCreate()
    const caddyStopDeferred = deferred<void>()
    let timeoutCallback: (() => void) | undefined
    let webStops = 0
    const daemonR = projectRegistryDaemonCreate({
      config: config({ shutdownTimeoutMs: 10 }),
      repository: repository(),
      caddyApplication: {
        start: async () => createResultError("caddy", "startup failed"),
        startup: async () => createResultError("caddy", "startup failed"),
        regenerate: async () => createResultError("caddy", "not started"),
        projectChange: async () => createResultError("caddy", "not started"),
        status: () => ({ pending: false }),
        stop: () => caddyStopDeferred.promise,
      },
      filesystem: fakeFilesystem.filesystem,
      serverFactory: (options) => {
        if (options.unix !== undefined) return { stop: () => undefined }
        return {
          stop: () => {
            webStops += 1
          },
        }
      },
      timer: {
        wait: async () => undefined,
        setInterval: () => undefined,
        clearInterval: () => undefined,
        setTimeout: (callback) => {
          timeoutCallback = callback
          return callback
        },
        clearTimeout: () => undefined,
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    const startPromise = daemonR.data.start()
    for (let index = 0; index < 20 && timeoutCallback === undefined; index += 1) await Promise.resolve()
    if (timeoutCallback === undefined) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
    expect(timeoutCallback).toBeDefined()
    timeoutCallback?.()
    expect((await startPromise).success).toBe(false)
    expect(webStops).toBe(1)
    caddyStopDeferred.resolve()
    expect((await daemonR.data.shutdown()).success).toBe(true)
  })

  test("cleans a socket entry left by a failed server factory", async () => {
    const fakeFilesystem = filesystemCreate()
    let unlinkFailures = 1
    const filesystem: ProjectRegistryDaemonFilesystem = {
      ...fakeFilesystem.filesystem,
      unlink: async (path) => {
        if (unlinkFailures > 0) {
          unlinkFailures -= 1
          throw new Error("entry unlink failed")
        }
        await fakeFilesystem.filesystem.unlink(path)
      },
    }
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice"] }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem,
      serverFactory: (options) => {
        if (options.unix !== undefined) {
          fakeFilesystem.entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
          throw new Error("server factory failed")
        }
        return { stop: () => undefined }
      },
      mappedUsersResolve: () => createResult([{ username: "alice", uid: 1001, gid: 1002 }]),
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(false)
    expect(fakeFilesystem.entries.has("/run/project-registry/alice.sock")).toBe(false)
    await daemonR.data.shutdown()
  })

  test("rejects custom mapped users that omit or add configured users", async () => {
    for (const resolvedUsers of [
      [],
      [
        { username: "alice", uid: 1001, gid: 1002 },
        { username: "bob", uid: 1003, gid: 1004 },
      ],
    ]) {
      const fakeFilesystem = filesystemCreate()
      const daemonR = projectRegistryDaemonCreate({
        config: config({ mappedUsers: ["alice"] }),
        repository: repository(),
        caddyApplication: caddyApplication(),
        filesystem: fakeFilesystem.filesystem,
        mappedUsersResolve: () => createResult(resolvedUsers),
        requireRoot: false,
      })
      expect(daemonR.success).toBe(true)
      if (!daemonR.success) continue

      expect((await daemonR.data.start()).success).toBe(false)
      expect(fakeFilesystem.entries.has("/run/project-registry/alice.sock")).toBe(false)
      await daemonR.data.shutdown()
    }
  })
})

describe("projectRegistryDaemon socket directory", () => {
  test("rejects an insecure existing ancestor", async () => {
    const fakeFilesystem = filesystemCreate()
    fakeFilesystem.entries.set("/run/insecure", { type: "directory", mode: 0o777, uid: 0, gid: 0 })
    const daemonR = projectRegistryDaemonCreate({
      config: config({ socketDirectory: "/run/insecure/project-registry" }),
      repository: repository(),
      caddyApplication: caddyApplication(),
      filesystem: fakeFilesystem.filesystem,
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(false)
    expect(fakeFilesystem.entries.has("/run/insecure/project-registry")).toBe(false)
  })

  test("corrects world-writable and wrong modes on a real root-owned temp directory", async () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return
    const directory = await mkdtemp(join("/run", "project-registry-"))
    try {
      for (const mode of [0o1777, 0o755]) {
        await fsChmod(directory, mode)
        const daemonR = projectRegistryDaemonCreate({
          config: config({ socketDirectory: directory }),
          repository: repository(),
          caddyApplication: caddyApplication(),
          filesystem: projectRegistryDaemonFilesystemDefault(),
          requireRoot: true,
        })
        expect(daemonR.success).toBe(true)
        if (!daemonR.success) return
        expect((await daemonR.data.start()).success).toBe(true)
        expect((await fsLstat(directory)).mode & 0o7777).toBe(0o700)
        await daemonR.data.shutdown()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects a real symlink replacement instead of following it", async () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return
    const parent = await mkdtemp(join("/run", "project-registry-"))
    const directory = join(parent, "sockets")
    const target = join(parent, "target")
    try {
      await rm(directory, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
      await symlink(target, directory)
      const daemonR = projectRegistryDaemonCreate({
        config: config({ socketDirectory: directory }),
        repository: repository(),
        caddyApplication: caddyApplication(),
        filesystem: projectRegistryDaemonFilesystemDefault(),
        requireRoot: true,
      })
      expect(daemonR.success).toBe(true)
      if (!daemonR.success) return
      expect((await daemonR.data.start()).success).toBe(false)
      expect(await fsLstat(target).catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("changes socket ownership on a real temp directory", async () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return
    const directory = await mkdtemp(join("/run", "project-registry-"))
    const servers: ProjectRegistryDaemonServer[] = []
    try {
      let mapping: ProjectRegistryDaemonMappedUser = { username: "alice", uid: 1001, gid: 1002 }
      const daemonR = projectRegistryDaemonCreate({
        config: config({ socketDirectory: directory }),
        repository: repository(),
        caddyApplication: caddyApplication(),
        filesystem: projectRegistryDaemonFilesystemDefault(),
        serverFactory: (options) => {
          if (options.unix === undefined) return { stop: () => undefined }
          const server = Bun.serve({ unix: options.unix, fetch: options.fetch })
          const value: ProjectRegistryDaemonServer = {
            stop: (stopOptions) => server.stop(stopOptions?.closeActiveConnections),
          }
          servers.push(value)
          return value
        },
        mappedUsersResolve: () => createResult([mapping]),
        requireRoot: true,
      })
      expect(daemonR.success).toBe(true)
      if (!daemonR.success) return
      expect((await daemonR.data.start()).success).toBe(true)
      mapping = { username: "alice", uid: 1003, gid: 1004 }
      expect((await daemonR.data.refreshSockets()).success).toBe(true)
      const stat = await fsLstat(join(directory, "alice.sock"))
      expect({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }).toEqual({ uid: 1003, gid: 1004, mode: 0o600 })
      await daemonR.data.shutdown()
    } finally {
      for (const server of servers) {
        try {
          await Promise.resolve(server.stop({ closeActiveConnections: true }))
        } catch {
          // The daemon normally stops every server before removing the temp directory.
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("retries failed cleanup of a real socket before recreating it", async () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return
    const directory = await mkdtemp(join("/run", "project-registry-"))
    const baseFilesystem = projectRegistryDaemonFilesystemDefault()
    const servers: ProjectRegistryDaemonServer[] = []
    let unlinkFailures = 1
    let stopFailures = 1
    let mapping: ProjectRegistryDaemonMappedUser = { username: "alice", uid: 1001, gid: 1002 }
    const filesystem: ProjectRegistryDaemonFilesystem = {
      ...baseFilesystem,
      async unlink(path) {
        if (unlinkFailures > 0) {
          unlinkFailures -= 1
          throw new Error("unlink failed")
        }
        await baseFilesystem.unlink(path)
      },
    }
    try {
      const daemonR = projectRegistryDaemonCreate({
        config: config({ socketDirectory: directory }),
        repository: repository(),
        caddyApplication: caddyApplication(),
        filesystem,
        serverFactory: (options) => {
          if (options.unix === undefined) return { stop: () => undefined }
          const server = Bun.serve({ unix: options.unix, fetch: options.fetch })
          const value: ProjectRegistryDaemonServer = {
            stop: (stopOptions) => {
              if (stopFailures > 0) {
                stopFailures -= 1
                throw new Error("stop failed")
              }
              return server.stop(stopOptions?.closeActiveConnections)
            },
          }
          servers.push(value)
          return value
        },
        mappedUsersResolve: () => createResult([mapping]),
        requireRoot: true,
      })
      expect(daemonR.success).toBe(true)
      if (!daemonR.success) return
      expect((await daemonR.data.start()).success).toBe(true)
      mapping = { username: "alice", uid: 1003, gid: 1004 }
      expect((await daemonR.data.refreshSockets()).success).toBe(false)
      expect((await daemonR.data.refreshSockets()).success).toBe(true)
      const stat = await fsLstat(join(directory, "alice.sock"))
      expect({ uid: stat.uid, gid: stat.gid }).toEqual({ uid: 1003, gid: 1004 })
      await daemonR.data.shutdown()
    } finally {
      for (const server of servers) {
        try {
          await Promise.resolve(server.stop({ closeActiveConnections: true }))
        } catch {
          // The daemon normally stops every server before removing the temp directory.
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects a wrong-owner real temp directory", async () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return
    const directory = await mkdtemp(join("/run", "project-registry-"))
    try {
      await fsChown(directory, 1001, 1001)
      const daemonR = projectRegistryDaemonCreate({
        config: config({ socketDirectory: directory }),
        repository: repository(),
        caddyApplication: caddyApplication(),
        filesystem: projectRegistryDaemonFilesystemDefault(),
        requireRoot: true,
      })
      expect(daemonR.success).toBe(true)
      if (!daemonR.success) return
      expect((await daemonR.data.start()).success).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
