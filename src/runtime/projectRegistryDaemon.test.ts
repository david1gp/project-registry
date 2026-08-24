import { describe, expect, test } from "bun:test"
import { chmod as fsChmod, chown as fsChown, lstat as fsLstat, mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { createResult, createResultError, createResultErrorCode } from "#result"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { Role } from "../access/Role.js"
import type { ProjectAccessLogSource } from "../access-log/ProjectAccessLogSource.js"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import { sessionCookieSerialize } from "../session/sessionCookieSerialize.js"
import { sessionStoreCreate } from "../session/sessionStoreCreate.js"
import { tokenReferenceStoreCreate } from "../session/tokenReferenceStoreCreate.js"
import type { ProjectRegistryDaemonBrowserAuth } from "./ProjectRegistryDaemonBrowserAuth.js"
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
import { projectRegistryDaemonOpen } from "./projectRegistryDaemonOpen.js"

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
    ownerHistory: async () => createResult([]),
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

function socketAccessCreate(username: string, role: Role, ownerRoles: Record<string, Role | undefined>): ProjectAccess {
  return {
    actorResolve: async () => createResult({ subject: `${username}-subject`, username, role }),
    ownerRoleResolve: async (owner) => createResult(ownerRoles[owner]),
  }
}

function randomBytes(value: number): () => ReturnType<typeof createResult<Uint8Array>> {
  return () => createResult(new Uint8Array(32).fill(value))
}

async function browserAuthCreate(
  input: string | readonly { username: string; role: Role }[],
): Promise<{ auth: ProjectRegistryDaemonBrowserAuth; cookie: string; cookies: Record<string, string> }> {
  const users = typeof input === "string" ? [{ username: input, role: "own" as const }] : input
  const tokenReferences = tokenReferenceStoreCreate({ randomBytes: randomBytes(1) })
  const tokenR = await tokenReferences.save({ accessToken: "browser-access-token", expiresAt: Date.now() + 60_000 })
  if (!tokenR.success) throw new Error(tokenR.errorMessage)
  let sessionRandomValue = 2
  const sessions = sessionStoreCreate({
    tokenReferences,
    randomBytes: () => createResult(new Uint8Array(32).fill(sessionRandomValue++)),
  })
  const cookies: Record<string, string> = {}
  for (const user of users) {
    const sessionR = await sessions.create({
      subject: `${user.username}-subject`,
      username: user.username,
      tokenReference: tokenR.data,
    })
    if (!sessionR.success) throw new Error(sessionR.errorMessage)
    const cookieR = sessionCookieSerialize(sessionR.data.id)
    if (!cookieR.success) throw new Error(cookieR.errorMessage)
    cookies[user.username] = cookieR.data.split(";", 1)[0]!
  }
  const firstUser = users[0]
  if (firstUser === undefined) throw new Error("browser users are required")
  return {
    auth: {
      sessions,
      tokenReferences,
      identityDirectory: {
        usersList: async () =>
          createResult(
            users.map((user) => ({
              subject: `${user.username}-subject`,
              preferredUsername: user.username,
            })),
          ),
        userRolesList: async (subject) => {
          const user = users.find((entry) => `${entry.username}-subject` === subject)
          return createResult(user === undefined ? [] : [user.role])
        },
        userPreferredUsernameResolve: async (subject) => {
          const user = users.find((entry) => `${entry.username}-subject` === subject)
          return user === undefined
            ? createResultError("browserAuthCreate", "user is unavailable")
            : createResult(user.username)
        },
      },
      posixUsers: { usernameExists: async (value) => createResult(users.some((user) => user.username === value)) },
    },
    cookie: cookies[firstUser.username]!,
    cookies,
  }
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
    async mkdir(path, mode) {
      entries.set(path, { type: "directory", mode, uid: 0, gid: 0 })
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
  requests: Array<{ context: string; fetch: (request: Request) => Response | Promise<Response> }>
  stops(): number
} {
  const contexts: string[] = []
  const requests: Array<{ context: string; fetch: (request: Request) => Response | Promise<Response> }> = []
  let stops = 0
  const factory: ProjectRegistryDaemonServerFactory = (options) => {
    const context = options.unix !== undefined ? options.unix : "http"
    if (options.unix !== undefined) {
      entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
      contexts.push("unix")
    } else {
      contexts.push("http")
    }
    requests.push({ context, fetch: options.fetch })
    const server: ProjectRegistryDaemonServer = {
      stop: () => {
        stops += 1
      },
    }
    return server
  }
  return { factory, contexts, requests, stops: () => stops }
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

  test("accepts loopback Caddy admin URLs with supported schemes and ports", () => {
    for (const caddyAdminUrl of ["http://localhost:2019", "https://127.0.0.1:9443", "https://[::1]:8443"]) {
      const result = projectRegistryDaemonConfigValidate({ repositoryPath: "/tmp/repository", caddyAdminUrl })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.caddyAdminUrl).toBe(caddyAdminUrl)
    }
  })

  test("rejects remote Caddy admin hosts and credentials", () => {
    for (const caddyAdminUrl of [
      "http://192.0.2.1:2019",
      "https://example.com:9443",
      "http://127.0.0.2:2019",
      "http://localhost.evil.example:2019",
      "http://user:password@localhost:2019",
    ]) {
      expect(projectRegistryDaemonConfigValidate({ repositoryPath: "/tmp/repository", caddyAdminUrl }).success).toBe(
        false,
      )
    }
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

  test("defaults and maps generated-config initialization explicitly", () => {
    const defaultsR = projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository" })
    expect(defaultsR.success).toBe(true)
    if (!defaultsR.success) return
    expect(defaultsR.data.initializeFromGeneratedConfig).toBe(false)

    const enabledR = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG: "true",
    })
    expect(enabledR.success).toBe(true)
    if (!enabledR.success) return
    expect(enabledR.data.initializeFromGeneratedConfig).toBe(true)

    const disabledR = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG: "off",
    })
    expect(disabledR.success).toBe(true)
    if (!disabledR.success) return
    expect(disabledR.data.initializeFromGeneratedConfig).toBe(false)

    expect(
      projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
        PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG: "sometimes",
      }).success,
    ).toBe(false)
  })

  test("optionally configures a strict Caddy access-log root", () => {
    const disabledR = projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository" })
    expect(disabledR.success).toBe(true)
    if (!disabledR.success) return
    expect(disabledR.data.caddyAccessLogRoot).toBeUndefined()

    const blankR = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT: "   ",
    })
    expect(blankR.success).toBe(true)
    if (!blankR.success) return
    expect(blankR.data.caddyAccessLogRoot).toBeUndefined()

    const enabledR = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT: "/var/lib/project-registry/logs",
      CADDY_USER: "caddy",
      CADDY_GROUP: "caddy",
    })
    expect(enabledR.success).toBe(true)
    if (!enabledR.success) return
    expect(enabledR.data.caddyAccessLogRoot).toBe("/var/lib/project-registry/logs")
    expect(enabledR.data.caddyUser).toBe("caddy")
    expect(enabledR.data.caddyGroup).toBe("caddy")

    expect(
      projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
        CADDY_USER: "caddy",
      }).success,
    ).toBe(false)

    for (const root of [
      "relative",
      "/",
      "/tmp/repository",
      "/tmp/repository/logs",
      "/var/logs/../other",
      "/var/logs/./access",
      "/var/logs/",
      "/var/logs\\access",
      "/var/\0logs",
    ]) {
      expect(
        projectRegistryDaemonConfigFromEnv({
          PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
          PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT: root,
        }).success,
      ).toBe(false)
    }
  })

  test("rejects an unsafe access-log root during startup validation", async () => {
    for (const root of ["/", "/tmp/repository", "/tmp/repository/logs"]) {
      const daemonR = await projectRegistryDaemonOpen({
        config: { repositoryPath: "/tmp/repository", caddyAccessLogRoot: root },
        requireRoot: false,
      })
      expect(daemonR.success).toBe(false)
    }
  })

  test("constructs and validates the Zitadel runtime and session environment", () => {
    const oidcOnlyR = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      PROJECT_REGISTRY_OIDC_ISSUER: "https://auth.example",
      PROJECT_REGISTRY_OIDC_CLIENT_ID: "client-id",
      PROJECT_REGISTRY_OIDC_CLIENT_SECRET: "client-secret",
      PROJECT_REGISTRY_OIDC_COOKIE_SECRET: "0".repeat(32),
    })
    expect(oidcOnlyR.success).toBe(true)
    if (oidcOnlyR.success) expect(oidcOnlyR.data.zitadel).toBeUndefined()

    const parsedR = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
      ZITADEL_ISSUER: "https://auth.example",
      ZITADEL_ORG_ID: "org-1",
      ZITADEL_PROJECT_ID: "project-1",
      ZITADEL_MANAGEMENT_TOKEN: "service-token",
      PROJECT_REGISTRY_SESSION_MAX_AGE_SECONDS: "7200",
      PROJECT_REGISTRY_SESSION_MAX_ENTRIES: "5000",
    })
    expect(parsedR.success).toBe(true)
    if (!parsedR.success) return
    expect(parsedR.data.zitadel).toEqual({
      issuer: "https://auth.example",
      orgId: "org-1",
      projectId: "project-1",
      serviceToken: "service-token",
    })
    expect(parsedR.data.session).toEqual({ maxAgeSeconds: 7200, maxEntries: 5000 })
    expect(
      projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
        ZITADEL_ISSUER: "https://auth.example",
        ZITADEL_ORG_ID: "org-1",
        ZITADEL_PROJECT_ID: "project-1",
      }).success,
    ).toBe(false)
    expect(
      projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
        PROJECT_REGISTRY_SESSION_MAX_ENTRIES: "0",
      }).success,
    ).toBe(false)
  })
})

describe("projectRegistryDaemonCreate", () => {
  test("starts live but not ready after failed generated-config validation and retries", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const intervals: Array<() => void> = []
    let validations = 0
    let loads = 0
    const daemonR = await projectRegistryDaemonOpen({
      config: config({ initializeFromGeneratedConfig: true, mappedUsers: ["leo"] }),
      repository: repository(),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: {
        isRoot: () => true,
        userResolve: async () => createResult({ username: "leo", uid: 1001, gid: 1002 }),
      },
      timer: {
        wait: async () => undefined,
        setInterval: (callback) => {
          intervals.push(callback)
          return callback
        },
        clearInterval: () => undefined,
      },
      caddyProcessRunner: async () => {
        validations += 1
        return createResult({ exitCode: validations <= 3 ? 1 : 0, stdout: "", stderr: "" })
      },
      caddyFetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(true)
    expect(validations).toBe(3)
    expect(loads).toBe(0)

    const initialReadinessR = await daemonR.data.readiness()
    expect(initialReadinessR.success).toBe(true)
    if (!initialReadinessR.success) return
    expect(initialReadinessR.data).toMatchObject({ ready: false, caddyReady: false })

    const unix = fakeServers.requests.find((entry) => entry.context.endsWith("/leo.sock"))
    expect(unix).toBeDefined()
    if (unix === undefined) return
    const statusResponse = await unix.fetch(new Request("http://localhost/api/v1/caddy/status"))
    expect(statusResponse.status).toBe(200)
    const statusBody = (await statusResponse.json()) as { data?: { appliedRevision?: string } }
    expect(statusBody).toMatchObject({
      success: true,
      data: {
        desiredRevision: "revision",
        pendingRevision: "revision",
        pending: true,
      },
    })
    expect(statusBody.data?.appliedRevision).toBeUndefined()

    intervals[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(validations).toBe(4)
    expect(loads).toBe(1)
    const recoveredReadinessR = await daemonR.data.readiness()
    expect(recoveredReadinessR.success).toBe(true)
    if (recoveredReadinessR.success) expect(recoveredReadinessR.data.ready).toBe(true)
    await daemonR.data.shutdown()
  })

  test("starts shared HTTP and per-user Unix listeners with private ownership", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const caddy = caddyApplication()
    const users: ProjectRegistryDaemonMappedUser[] = [
      { username: "alice", uid: 1001, gid: 1002 },
      { username: "bob", uid: 1003, gid: 1004 },
    ]
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["alice", "bob"], socketDirectory: "/run/project-registry" }),
      repository: repository(),
      caddyApplication: caddy,
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: {
        isRoot: () => true,
        userResolve: async (username) =>
          createResult(users.find((user) => user.username === username) as ProjectRegistryDaemonMappedUser),
      },
      requireRoot: true,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    const startR = await daemonR.data.start()
    expect(startR.success).toBe(true)
    expect(fakeServers.contexts).toEqual(["http", "unix", "unix"])
    expect(fakeFilesystem.entries.get("/run/project-registry")).toEqual({
      type: "directory",
      mode: 0o755,
      uid: 0,
      gid: 0,
    })
    for (const user of users) {
      const socket = fakeFilesystem.entries.get(`/run/project-registry/${user.username}.sock`)
      expect(socket).toEqual({ type: "socket", mode: 0o600, uid: user.uid, gid: user.gid })
      if (socket === undefined) continue
      expect(socket.mode & 0o077).toBe(0)
    }
    const readinessR = await daemonR.data.readiness()
    expect(readinessR.success && readinessR.data.ready).toBe(true)
    await daemonR.data.shutdown()
    expect(fakeFilesystem.entries.has("/run/project-registry/alice.sock")).toBe(false)
    expect(caddy.stops).toBe(1)
    await daemonR.data.shutdown()
    expect(caddy.stops).toBe(1)
  })

  test("wires health and the owner API to production HTTP and Unix listeners", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const apiRevision = "a".repeat(40)
    const apiRepository = repository()
    apiRepository.read = async () => createResult({ projects: [], revision: apiRevision })
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["leo"], socketDirectory: "/run/project-registry" }),
      repository: apiRepository,
      caddyApplication: caddyApplication(),
      socketAccessResolve: async (username) => createResult(socketAccessCreate(username, "own", { leo: "own" })),
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: {
        isRoot: () => true,
        userResolve: async () => createResult({ username: "leo", uid: 1001, gid: 1002 }),
      },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    const http = fakeServers.requests.find((entry) => entry.context === "http")
    const unix = fakeServers.requests.find((entry) => entry.context.endsWith("/leo.sock"))
    expect(http).toBeDefined()
    expect(unix).toBeDefined()
    if (http === undefined || unix === undefined) return

    const health = await http.fetch(new Request("http://localhost/health/live"))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ live: true, state: "running" })

    const denied = await http.fetch(new Request("http://localhost/api/v1/users/leo/projects"))
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({
      success: false,
      error: {
        code: "api.unauthenticated",
        hint: "Sign in again, then retry. If the problem persists, contact an administrator.",
      },
    })

    const listed = await unix.fetch(new Request("http://localhost/api/v1/users/leo/projects"))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ success: true, data: { projects: [], revision: apiRevision } })

    await daemonR.data.shutdown()
  })

  test("resolves current Unix roles for cross-owner access without trusting request headers", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const users: ProjectRegistryDaemonMappedUser[] = [
      { username: "alice", uid: 1001, gid: 1002 },
      { username: "bob", uid: 1003, gid: 1004 },
      { username: "root", uid: 1005, gid: 1006 },
    ]
    const projects = [
      { ...caddyConfigGenerateFixtures.proxy, owner: "alice", name: "alice-app" },
      { ...caddyConfigGenerateFixtures.proxy, owner: "bob", name: "other" },
      { ...caddyConfigGenerateFixtures.proxy, owner: "root", name: "root-app" },
    ]
    const apiRepository = repository()
    apiRepository.get = async (key) => {
      const project = projects.find((item) => item.owner === key.owner && item.name === key.name)
      return project === undefined
        ? createResultErrorCode("projectRepositoryGet", "project not found", "projects.not-found")
        : createResult({ project, revision: "a".repeat(40) })
    }
    const ownerRoles: Record<string, Role | undefined> = { alice: "own", bob: "own", root: "superadmin" }
    const resolvedUsers: string[] = []
    const source: ProjectAccessLogSource = {
      read: async () => createResult({ records: [], partial: false, malformedLines: 0 }),
    }
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: users.map((user) => user.username), socketDirectory: "/run/project-registry" }),
      repository: apiRepository,
      caddyApplication: caddyApplication(),
      projectAccessLogSource: source,
      socketAccessResolve: async (username) => {
        resolvedUsers.push(username)
        const role = username === "alice" ? "admin" : username === "root" ? "superadmin" : "own"
        return createResult(socketAccessCreate(username, role, ownerRoles))
      },
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: {
        isRoot: () => true,
        userResolve: async (username) =>
          createResult(users.find((user) => user.username === username) as ProjectRegistryDaemonMappedUser),
      },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    const alice = fakeServers.requests.find((entry) => entry.context.endsWith("/alice.sock"))
    const bob = fakeServers.requests.find((entry) => entry.context.endsWith("/bob.sock"))
    const root = fakeServers.requests.find((entry) => entry.context.endsWith("/root.sock"))
    expect(alice).toBeDefined()
    expect(bob).toBeDefined()
    expect(root).toBeDefined()
    if (alice === undefined || bob === undefined || root === undefined) return

    const admin = await alice.fetch(
      new Request("http://localhost/api/v1/users/bob/projects/other/access-logs", {
        headers: { "x-user": "root" },
      }),
    )
    expect(admin.status).toBe(200)

    const adminDenied = await alice.fetch(
      new Request("http://localhost/api/v1/users/root/projects/root-app/access-logs"),
    )
    expect(adminDenied.status).toBe(404)

    const ownDenied = await bob.fetch(new Request("http://localhost/api/v1/users/alice/projects/alice-app/access-logs"))
    expect(ownDenied.status).toBe(404)

    const superadmin = await root.fetch(new Request("http://localhost/api/v1/users/bob/projects/other/access-logs"))
    expect(superadmin.status).toBe(200)
    expect(resolvedUsers).toEqual(["alice", "alice", "bob", "root"])

    await daemonR.data.shutdown()
  })

  test("applies the browser project access role matrix at the live HTTP boundary", async () => {
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const browser = await browserAuthCreate([
      { username: "leo", role: "own" },
      { username: "alice", role: "admin" },
      { username: "bob", role: "own" },
      { username: "root", role: "superadmin" },
    ])
    const projects = [
      { ...caddyConfigGenerateFixtures.proxy, owner: "leo", name: "leo-app" },
      { ...caddyConfigGenerateFixtures.proxy, owner: "bob", name: "bob-app" },
      { ...caddyConfigGenerateFixtures.proxy, owner: "root", name: "root-app" },
      { ...caddyConfigGenerateFixtures.proxy, owner: "ghost", name: "ghost-app" },
    ]
    const sourceProjects: string[] = []
    const source: ProjectAccessLogSource = {
      read: async (key) => {
        sourceProjects.push(`${key.owner}/${key.name}`)
        return createResult({ records: [], partial: false, malformedLines: 0 })
      },
    }
    const apiRepository = repository()
    apiRepository.get = async (key) => {
      const project = projects.find((item) => item.owner === key.owner && item.name === key.name)
      return project === undefined
        ? createResultErrorCode("projectRepositoryGet", "project not found", "projects.not-found")
        : createResult({ project, revision: "a".repeat(40) })
    }
    const daemonR = projectRegistryDaemonCreate({
      config: config({ mappedUsers: ["leo"], socketDirectory: "/run/project-registry" }),
      repository: apiRepository,
      caddyApplication: caddyApplication(),
      projectAccessLogSource: source,
      browserAuth: browser.auth,
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: {
        isRoot: () => true,
        userResolve: async () => createResult({ username: "leo", uid: 1001, gid: 1002 }),
      },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    const http = fakeServers.requests.find((entry) => entry.context === "http")
    expect(http).toBeDefined()
    if (http === undefined) return

    const forged = await http.fetch(
      new Request("http://localhost/api/v1/users/leo/projects/leo-app/access-logs", {
        headers: { "x-user": "leo" },
      }),
    )
    expect(forged.status).toBe(401)

    const ownProject = await http.fetch(
      new Request("http://localhost/api/v1/users/leo/projects/leo-app/access-logs", {
        headers: { cookie: browser.cookies.leo! },
      }),
    )
    const ownProjectBody = await ownProject.json()
    expect(ownProject.status).toBe(200)
    expect(ownProjectBody).toMatchObject({ success: true, data: { records: [] } })

    const adminAllowed = await http.fetch(
      new Request("http://localhost/api/v1/users/bob/projects/bob-app/access-logs", {
        headers: { cookie: browser.cookies.alice! },
      }),
    )
    expect(adminAllowed.status).toBe(200)

    const adminDenied = await http.fetch(
      new Request("http://localhost/api/v1/users/root/projects/root-app/access-logs", {
        headers: { cookie: browser.cookies.alice! },
      }),
    )
    expect(adminDenied.status).toBe(404)
    const adminDeniedBody = await adminDenied.json()
    expect(adminDeniedBody).toMatchObject({
      success: false,
      error: { code: "access-log.not-found", status: 404 },
    })

    const superadmin = await http.fetch(
      new Request("http://localhost/api/v1/users/root/projects/root-app/access-logs", {
        headers: { cookie: browser.cookies.root! },
      }),
    )
    expect(superadmin.status).toBe(200)

    const unresolvedOwner = await http.fetch(
      new Request("http://localhost/api/v1/users/ghost/projects/ghost-app/access-logs", {
        headers: { cookie: browser.cookies.alice! },
      }),
    )
    expect(unresolvedOwner.status).toBe(404)

    const missingProject = await http.fetch(
      new Request("http://localhost/api/v1/users/leo/projects/missing/access-logs", {
        headers: { cookie: browser.cookies.alice! },
      }),
    )
    expect(missingProject.status).toBe(404)
    expect(await missingProject.json()).toEqual(adminDeniedBody)
    expect(sourceProjects).toEqual(["leo/leo-app", "bob/bob-app", "root/root-app"])

    await daemonR.data.shutdown()
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
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
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
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
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

describe("projectRegistryDaemonOpen production identity composition", () => {
  test("resolves authenticated HTTP and Unix roles through Zitadel and POSIX adapters", async () => {
    const now = Date.now()
    const fakeFilesystem = filesystemCreate()
    const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
    const tokenReferences = tokenReferenceStoreCreate({ clock: () => now, randomBytes: randomBytes(21) })
    const tokenR = await tokenReferences.save({ accessToken: "browser-token", expiresAt: now + 60_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({
      tokenReferences,
      clock: () => now,
      randomBytes: randomBytes(22),
      maxAgeSeconds: 60,
    })
    const sessionR = await sessions.create({ subject: "subject-1", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    const cookieR = sessionCookieSerialize(sessionR.data.id)
    expect(cookieR.success).toBe(true)
    if (!cookieR.success) return
    const cookie = cookieR.data.split(";", 1)[0]!

    const project = { ...caddyConfigGenerateFixtures.proxy, owner: "alice", name: "production" }
    const apiRepository = repository()
    apiRepository.get = async (key) =>
      key.owner === project.owner && key.name === project.name
        ? createResult({ project, revision: "a".repeat(40) })
        : createResultError("projectRepositoryGet", "project not found")
    const source: ProjectAccessLogSource = {
      read: async () => createResult({ records: [], partial: false, malformedLines: 0 }),
    }
    const seenTokens: string[] = []
    const grantResponse = JSON.stringify({
      result: [
        {
          userId: "subject-1",
          preferredLoginName: "alice",
          projectId: "project-1",
          orgId: "org-1",
          roleKeys: ["admin"],
          state: "USER_GRANT_STATE_ACTIVE",
        },
      ],
      details: { totalResult: 1 },
    })
    const daemonR = await projectRegistryDaemonOpen({
      config: config({
        mappedUsers: ["alice"],
        socketDirectory: "/run/project-registry",
        zitadel: {
          issuer: "https://auth.example",
          orgId: "org-1",
          projectId: "project-1",
          serviceToken: "service-token",
        },
        session: { maxAgeSeconds: 60, maxEntries: 10 },
      }),
      repository: apiRepository,
      caddyApplication: caddyApplication(),
      projectAccessLogSource: source,
      sessions,
      tokenReferences,
      zitadelHttp: async (_input, init) => {
        seenTokens.push(new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "")
        return new Response(grantResponse, { status: 200 })
      },
      filesystem: fakeFilesystem.filesystem,
      serverFactory: fakeServers.factory,
      posix: {
        isRoot: () => true,
        userResolve: async () => createResult({ username: "alice", uid: 1001, gid: 1002 }),
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    expect((await daemonR.data.start()).success).toBe(true)

    const http = fakeServers.requests.find((entry) => entry.context === "http")
    const unix = fakeServers.requests.find((entry) => entry.context.endsWith("/alice.sock"))
    expect(http).toBeDefined()
    expect(unix).toBeDefined()
    if (http === undefined || unix === undefined) return

    const authenticatedHttp = await http.fetch(
      new Request("http://localhost/api/v1/users/alice/projects/production/access-logs", {
        headers: { cookie, "x-user": "forged" },
      }),
    )
    expect(authenticatedHttp.status).toBe(200)

    const authenticatedUnix = await unix.fetch(
      new Request("http://localhost/api/v1/users/alice/projects/production/access-logs", {
        headers: { "x-user": "root" },
      }),
    )
    expect(authenticatedUnix.status).toBe(200)
    expect(seenTokens).toContain("browser-token")
    expect(seenTokens).toContain("service-token")

    await daemonR.data.shutdown()
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
        expect((await fsLstat(directory)).mode & 0o7777).toBe(0o755)
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
        config: config({ mappedUsers: ["alice"], socketDirectory: directory }),
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
      expect((await fsLstat(directory)).mode & 0o7777).toBe(0o755)
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
        config: config({ mappedUsers: ["alice"], socketDirectory: directory }),
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
