import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import { projectRegistryApiHandlerCreate } from "../api/projectRegistryApiHandlerCreate.js"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { Project } from "../project/Project.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"
import type { ProjectRegistryDaemonFilesystem } from "./ProjectRegistryDaemonFilesystem.js"
import type { ProjectRegistryDaemonRequestContext } from "./ProjectRegistryDaemonRequestContext.js"
import type { ProjectRegistryDaemonServer } from "./ProjectRegistryDaemonServer.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"
import { projectRegistryDaemonCreate } from "./projectRegistryDaemonCreate.js"
import { projectRegistryWikiSyncCreate } from "./projectRegistryWikiSyncCreate.js"
import type { WikiReconcileInput, WikiReconcileSummary } from "../wiki/wikiReconcile.js"

const revisionA = "a".repeat(40)
const revisionB = "b".repeat(40)

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function leoProject(name: string, labels: Record<string, string> = {}): Project {
  return { schemaVersion: 2, owner: "leo", name, order: 1, labels, services: [] }
}

function reconcileSpy(options: { result?: Result<WikiReconcileSummary>; delayMs?: number } = {}): {
  calls: WikiReconcileInput[]
  active: { current: number; maximum: number }
  hook(input: WikiReconcileInput): Promise<Result<WikiReconcileSummary>>
} {
  const calls: WikiReconcileInput[] = []
  const active = { current: 0, maximum: 0 }
  return {
    calls,
    active,
    hook: async (input) => {
      calls.push(input)
      active.current += 1
      active.maximum = Math.max(active.maximum, active.current)
      try {
        if (options.delayMs !== undefined) await sleep(options.delayMs)
        return (
          options.result ??
          createResult({ processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, skippedMessages: [] })
        )
      } finally {
        active.current -= 1
      }
    },
  }
}

async function waitFor(calls: { length: number }, count: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (calls.length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} reconcile calls`)
    await sleep(5)
  }
}

function accessCreate(username: string): ProjectAccess {
  return {
    actorResolve: async () => createResult({ subject: null, username, role: "own" as const }),
    ownerRoleResolve: async () => createResult("own" as const),
  }
}

function repositoryCreate(initial: Project[]): ProjectRepository & { revision: string; projects: Project[] } {
  const repository = {
    revision: "a".repeat(40),
    projects: [...initial],
    read: async () => createResult({ projects: repository.projects, revision: repository.revision }),
    get: async (key: { owner: string; name: string }) => {
      const project = repository.projects.find((entry) => entry.owner === key.owner && entry.name === key.name)
      return project === undefined
        ? createResultErrorCode("projectRepositoryGet", "project not found", "projects.not-found")
        : createResult({ project, revision: repository.revision })
    },
    getUserDefaultDomain: async (owner: string) => createResult({ owner, domain: undefined, revision: revisionA }),
    create: async (project: unknown, options: { expectedRevision: string }) => {
      if (options.expectedRevision !== repository.revision) {
        return createResultErrorCode("projectRepositoryCreate", "revision mismatch", "projects.revision-conflict")
      }
      repository.projects.push(project as Project)
      repository.revision = revisionB
      return createResult({
        action: "create" as const,
        key: { owner: (project as Project).owner, name: (project as Project).name },
        changed: true,
        revision: revisionB,
        localCommit: { status: "committed" as const, revision: revisionB },
        push: { requested: false as const, status: "not-requested" as const },
      } satisfies ProjectRepositoryMutation)
    },
    edit: async (key: { owner: string; name: string }, project: unknown, options: { expectedRevision: string }) => {
      if (options.expectedRevision !== repository.revision) {
        return createResultErrorCode("projectRepositoryEdit", "revision mismatch", "projects.revision-conflict")
      }
      const index = repository.projects.findIndex((entry) => entry.owner === key.owner && entry.name === key.name)
      if (index < 0) return createResultErrorCode("projectRepositoryEdit", "project not found", "projects.not-found")
      repository.projects[index] = project as Project
      repository.revision = revisionB
      return createResult({
        action: "edit" as const,
        key,
        changed: true,
        revision: revisionB,
        localCommit: { status: "committed" as const, revision: revisionB },
        push: { requested: false as const, status: "not-requested" as const },
      } satisfies ProjectRepositoryMutation)
    },
    delete: async () => createResultError("projectRepositoryDelete", "not implemented"),
    transact: async (options: {
      expectedRevision: string
      writes: unknown[]
      removals: { owner: string; name: string }[]
    }) => {
      if (options.expectedRevision !== repository.revision) {
        return createResultErrorCode("projectRepositoryTransaction", "revision mismatch", "projects.revision-conflict")
      }
      const writes = options.writes as Project[]
      repository.projects = repository.projects
        .filter((project) => !options.removals.some((key) => key.owner === project.owner && key.name === project.name))
        .filter((project) => !writes.some((write) => write.owner === project.owner && write.name === project.name))
        .concat(writes)
      repository.revision = revisionB
      return createResult({
        action: "transaction" as const,
        changed: true,
        revision: revisionB,
        localCommit: { status: "committed" as const, revision: revisionB },
        push: { requested: false as const, status: "not-requested" as const },
        written: writes.map(({ owner, name }) => ({ owner, name })),
        removed: options.removals,
      })
    },
    migrate: async () => createResultError("projectRepositoryMigration", "not implemented"),
    setUserDefaultDomain: async () => createResultError("projectRepositoryUserDefaultDomain", "not implemented"),
    history: async () => createResult([]),
    ownerHistory: async () => createResult([]),
    readiness: async () => createResult({ ready: true, clean: true, revision: repository.revision }),
    recover: async () => createResult({ ready: true, clean: true, revision: repository.revision }),
  }
  return repository
}

function socketAccessResolveCreate(): (username: string) => Promise<Result<ProjectAccess>> {
  return async (username) => createResult(accessCreate(username))
}

function daemonFilesystemCreate(): {
  filesystem: ProjectRegistryDaemonFilesystem
  entries: Map<string, ProjectRegistryDaemonFileStat>
} {
  const entries = new Map<string, ProjectRegistryDaemonFileStat>([
    ["/", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
    ["/run", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
  ])
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
    },
    async chown(path, uid, gid) {
      const entry = entries.get(path)
      if (entry === undefined) throw new Error("missing path")
      entry.uid = uid
      entry.gid = gid
    },
    async unlink(path) {
      entries.delete(path)
    },
  }
  return { filesystem, entries }
}

function caddyApplicationCreate(): {
  projectChanges: number
  projectChange(): Promise<Result<{ revision: string; changed: boolean; applied: boolean; attempts: number }>>
  regenerate(): Promise<Result<{ revision: string; changed: boolean; applied: boolean; attempts: number }>>
  status(): { pending: boolean }
} {
  const application = {
    projectChanges: 0,
    projectChange: async () => {
      application.projectChanges += 1
      return createResult({ revision: revisionB, changed: true, applied: true, attempts: 1 })
    },
    regenerate: async () => createResult({ revision: revisionB, changed: true, applied: true, attempts: 1 }),
    status: () => ({ pending: false }),
  }
  return application
}

async function handlerJson(
  handler: ReturnType<typeof projectRegistryApiHandlerCreate>,
  path: string,
  context: ProjectRegistryDaemonRequestContext,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    }),
    context,
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("projectRegistryWikiSyncCreate", () => {
  test("rejects invalid queue options", () => {
    expect(
      projectRegistryWikiSyncCreate({ wikiRoot: "", repositoryProjectsCurrent: async () => createResult([]) }).success,
    ).toBe(false)
    expect(
      projectRegistryWikiSyncCreate({
        wikiRoot: "/tmp/wiki",
        repositoryProjectsCurrent: undefined as unknown as () => Promise<Result<readonly unknown[]>>,
      }).success,
    ).toBe(false)
    expect(
      projectRegistryWikiSyncCreate({
        wikiRoot: "/tmp/wiki",
        repositoryProjectsCurrent: async () => createResult([]),
        reconcile: "nope" as unknown as (input: WikiReconcileInput) => Promise<Result<WikiReconcileSummary>>,
      }).success,
    ).toBe(false)
  })

  test("stays idle without a wiki root", async () => {
    const spy = reconcileSpy()
    const syncR = projectRegistryWikiSyncCreate({
      repositoryProjectsCurrent: async () => createResult([leoProject("demo")]),
      reconcile: spy.hook,
    })
    expect(syncR.success).toBe(true)
    if (!syncR.success) return
    expect((await syncR.data.startup()).success).toBe(true)
    syncR.data.schedule()
    syncR.data.projectCreateAfterPersistence(leoProject("demo"), { noDns: false })
    syncR.data.projectEditAfterPersistence(leoProject("demo"), leoProject("demo"))
    syncR.data.projectOrganizeAfterPersistence()
    await sleep(20)
    expect(spy.calls).toHaveLength(0)
    expect((await syncR.data.shutdown()).success).toBe(true)
  })

  test("reconciles the latest persisted snapshot on startup with owner leo", async () => {
    const spy = reconcileSpy()
    const projects = [
      leoProject("alpha"),
      { schemaVersion: 2, owner: "david", name: "other", labels: {}, services: [] },
    ]
    const syncR = projectRegistryWikiSyncCreate({
      wikiRoot: "/home/leo/wiki",
      repositoryProjectsCurrent: async () => createResult(projects),
      reconcile: spy.hook,
    })
    expect(syncR.success).toBe(true)
    if (!syncR.success) return
    const startupR = await syncR.data.startup()
    expect(startupR.success).toBe(true)
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]?.root).toBe("/home/leo/wiki")
    expect(spy.calls[0]?.owner).toBe("leo")
    expect(spy.calls[0]?.snapshot).toEqual({ projects })
    await syncR.data.shutdown()
  })

  test("coalesces burst schedules into one serialized run with the latest snapshot", async () => {
    const spy = reconcileSpy({ delayMs: 20 })
    let projects: unknown[] = [leoProject("one")]
    const syncR = projectRegistryWikiSyncCreate({
      wikiRoot: "/home/leo/wiki",
      repositoryProjectsCurrent: async () => createResult(projects),
      reconcile: spy.hook,
    })
    expect(syncR.success).toBe(true)
    if (!syncR.success) return
    await syncR.data.startup()
    expect(spy.calls).toHaveLength(1)
    projects = [leoProject("one"), leoProject("two")]
    syncR.data.projectCreateAfterPersistence(leoProject("two"), { noDns: false })
    syncR.data.projectEditAfterPersistence(leoProject("one"), leoProject("one"))
    syncR.data.projectOrganizeAfterPersistence()
    await waitFor(spy.calls, 2)
    await sleep(50)
    expect(spy.calls).toHaveLength(2)
    expect(spy.calls[1]?.snapshot).toEqual({ projects })
    expect(spy.active.maximum).toBe(1)
    await syncR.data.shutdown()
  })

  test("logs snapshot and reconcile failures without failing later runs", async () => {
    const messages: string[] = []
    let snapshotCalls = 0
    const spy = reconcileSpy({
      result: createResultError("wikiReconcile", "wiki root is unavailable"),
    })
    const syncR = projectRegistryWikiSyncCreate({
      wikiRoot: "/home/leo/wiki",
      repositoryProjectsCurrent: async () => {
        snapshotCalls += 1
        return snapshotCalls === 1
          ? createResultError("projectRegistryRepositoryRead", "repository is unavailable")
          : createResult([leoProject("demo")])
      },
      reconcile: spy.hook,
      logger: (message) => messages.push(message),
    })
    expect(syncR.success).toBe(true)
    if (!syncR.success) return
    expect((await syncR.data.startup()).success).toBe(true)
    expect(spy.calls).toHaveLength(0)
    expect(messages.some((message) => message.includes("snapshot"))).toBe(true)
    syncR.data.schedule()
    await waitFor(spy.calls, 1)
    expect(messages.some((message) => message.includes("wiki root is unavailable"))).toBe(true)
    await syncR.data.shutdown()
  })

  test("ignores schedules before start and after shutdown, awaiting in-flight work", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const spy = reconcileSpy()
    const gated = async (input: WikiReconcileInput) => {
      const result = await spy.hook(input)
      await gate
      return result
    }
    const syncR = projectRegistryWikiSyncCreate({
      wikiRoot: "/home/leo/wiki",
      repositoryProjectsCurrent: async () => createResult([leoProject("demo")]),
      reconcile: gated,
    })
    expect(syncR.success).toBe(true)
    if (!syncR.success) return
    syncR.data.schedule()
    expect(spy.calls).toHaveLength(0)
    const startupPromise = syncR.data.startup()
    await waitFor(spy.calls, 1)
    const shutdownPromise = syncR.data.shutdown()
    let shutdownSettled = false
    void shutdownPromise.then(() => {
      shutdownSettled = true
    })
    await sleep(20)
    expect(shutdownSettled).toBe(false)
    release()
    expect((await startupPromise).success).toBe(true)
    expect((await shutdownPromise).success).toBe(true)
    syncR.data.schedule()
    await sleep(20)
    expect(spy.calls).toHaveLength(1)
  })
})

describe("projectRegistryApiHandlerWikiSync", () => {
  test("runs organize, create, and edit hooks only after successful persistence", async () => {
    const repository = repositoryCreate([leoProject("seed", { section: "kunden" })])
    const calls: string[] = []
    const handler = projectRegistryApiHandlerCreate({
      repository,
      caddyApplication: caddyApplicationCreate(),
      socketAccessResolve: socketAccessResolveCreate(),
      projectCreateAfterPersistence: () => calls.push("create"),
      projectEditAfterPersistence: () => calls.push("edit"),
      projectOrganizeAfterPersistence: () => calls.push("organize"),
    })
    const leo = { transport: "unix", username: "leo" } as const

    const created = await handlerJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: revisionA,
      name: "wiki-app",
      caddy: { domains: ["wiki-app.example"] },
    })
    expect(created.status).toBe(201)

    const edited = await handlerJson(handler, "/api/v1/users/leo/projects/wiki-app", leo, "PATCH", {
      expectedRevision: revisionB,
      labels: { section: "Kunden", customerName: "Acme", customerEmail: "docs@acme.example" },
    })
    expect(edited.status).toBe(200)

    const organized = await handlerJson(handler, "/api/v1/users/leo/projects/organization", leo, "POST", {
      expectedRevision: revisionB,
      operation: { action: "sectionRename", section: "kunden", displayName: "Kunden" },
    })
    expect(organized.status).toBe(200)
    expect(calls).toEqual(["create", "edit", "organize"])
  })

  test("skips post-persistence hooks on failed mutations and survives throwing hooks", async () => {
    const repository = repositoryCreate([leoProject("seed", { section: "kunden" })])
    const calls: string[] = []
    const handler = projectRegistryApiHandlerCreate({
      repository,
      caddyApplication: caddyApplicationCreate(),
      socketAccessResolve: socketAccessResolveCreate(),
      projectCreateAfterPersistence: () => {
        calls.push("create")
        throw new Error("hook exploded")
      },
      projectEditAfterPersistence: () => calls.push("edit"),
      projectOrganizeAfterPersistence: () => {
        calls.push("organize")
        throw new Error("hook exploded")
      },
    })
    const leo = { transport: "unix", username: "leo" } as const

    const failedCreate = await handlerJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: "c".repeat(40),
      name: "nope",
      caddy: { domains: ["nope.example"] },
    })
    expect(failedCreate.status).toBe(409)

    const failedOrganize = await handlerJson(handler, "/api/v1/users/leo/projects/organization", leo, "POST", {
      expectedRevision: "c".repeat(40),
      operation: { action: "sectionRename", section: "kunden", displayName: "Kunden" },
    })
    expect(failedOrganize.status).toBe(409)
    expect(calls).toEqual([])

    const created = await handlerJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: revisionA,
      name: "wiki-app",
      caddy: { domains: ["wiki-app.example"] },
    })
    expect(created.status).toBe(201)

    const organized = await handlerJson(handler, "/api/v1/users/leo/projects/organization", leo, "POST", {
      expectedRevision: revisionB,
      operation: { action: "sectionRename", section: "kunden", displayName: "Kunden" },
    })
    expect(organized.status).toBe(200)
    expect(calls).toEqual(["create", "organize"])
  })
})

describe("projectRegistryDaemonWikiSync", () => {
  test("awaits initial wiki sync on startup and syncs later mutations without touching other owners", async () => {
    const wikiRoot = temporaryDirectory("project-registry-wiki-")
    const seed: Project = {
      schemaVersion: 2,
      owner: "leo",
      name: "seed-app",
      labels: { section: "kunden" },
      order: 1,
      services: [],
    }
    const david: Project = {
      schemaVersion: 2,
      owner: "david",
      name: "david-app",
      order: 1,
      labels: {},
      services: [],
    }
    const repository = repositoryCreate([seed, david])
    const { filesystem, entries } = daemonFilesystemCreate()
    const fetches: Array<(request: Request) => Response | Promise<Response>> = []
    const serverFactory: ProjectRegistryDaemonServerFactory = (options) => {
      if (options.unix !== undefined) entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
      fetches.push(options.fetch)
      const server: ProjectRegistryDaemonServer = { stop: () => undefined }
      return server
    }
    const configR = projectRegistryDaemonConfigValidate({
      repositoryPath: "/tmp/project-registry-wiki-test",
      wikiRoot,
      mappedUsers: ["leo"],
      serverIp: "127.0.0.1",
      serverIpCachePath: join(temporaryDirectory("project-registry-wiki-cache-"), "server-ip"),
      cloudflareDns: { enabled: false },
    })
    expect(configR.success).toBe(true)
    if (!configR.success) return
    const daemonR = projectRegistryDaemonCreate({
      config: configR.data,
      repository,
      caddyApplication: {
        start: async () => createResult({ revision: revisionA, changed: true, applied: true, attempts: 1 }),
        startup: async () => createResult({ revision: revisionA, changed: true, applied: true, attempts: 1 }),
        projectChange: async () => createResult({ revision: revisionB, changed: true, applied: true, attempts: 1 }),
        regenerate: async () => createResult({ revision: revisionA, changed: true, applied: true, attempts: 1 }),
        status: () => ({ pending: false }),
        stop: async () => undefined,
      },
      filesystem,
      serverFactory,
      posix: {
        isRoot: async () => true,
        userResolve: async () => createResult({ username: "leo", uid: 1000, gid: 1000 }),
      },
      socketAccessResolve: async () => createResult(accessCreate("leo")),
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    try {
      expect((await daemonR.data.start()).success).toBe(true)
      const seedNote = join(wikiRoot, "Projekte", "Externe", "seed-app", "seed-app.md")
      expect(existsSync(seedNote)).toBe(true)
      expect(existsSync(join(wikiRoot, "Projekte", "Interne", "david-app", "david-app.md"))).toBe(false)

      const unixFetch = fetches[fetches.length - 1]!
      const created = await unixFetch(
        new Request("http://localhost/api/v1/users/leo/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: repository.revision,
            name: "wiki-app",
            caddy: { domains: ["wiki-app.example"] },
          }),
        }),
      )
      expect(created.status).toBe(201)
      const createdNote = join(wikiRoot, "Projekte", "Interne", "wiki-app", "wiki-app.md")
      const deadline = Date.now() + 5_000
      while (!existsSync(createdNote)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for wiki create sync")
        await sleep(10)
      }

      const edited = await unixFetch(
        new Request("http://localhost/api/v1/users/leo/projects/wiki-app", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: repository.revision,
            labels: { section: "Kunden", customerName: "Acme", customerEmail: "docs@acme.example" },
          }),
        }),
      )
      expect(edited.status).toBe(200)
      const editDeadline = Date.now() + 5_000
      while (!readFileSync(createdNote, "utf8").includes("docs@acme.example")) {
        if (Date.now() > editDeadline) throw new Error("timed out waiting for wiki edit sync")
        await sleep(10)
      }

      const organized = await unixFetch(
        new Request("http://localhost/api/v1/users/leo/projects/organization", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: repository.revision,
            operation: { action: "sectionRename", section: "kunden", displayName: "Kundenbetreuung" },
          }),
        }),
      )
      expect(organized.status).toBe(200)
      const organizeDeadline = Date.now() + 5_000
      while (!readFileSync(seedNote, "utf8").includes("Kundenbetreuung")) {
        if (Date.now() > organizeDeadline) throw new Error("timed out waiting for wiki organize sync")
        await sleep(10)
      }
      expect(existsSync(join(wikiRoot, "Projekte", "Interne", "david-app", "david-app.md"))).toBe(false)
    } finally {
      await daemonR.data.shutdown()
    }
  })

  test("starts without wiki sync when no wiki root is configured", async () => {
    const repository = repositoryCreate([leoProject("seed")])
    const { filesystem, entries } = daemonFilesystemCreate()
    const configR = projectRegistryDaemonConfigValidate({
      repositoryPath: "/tmp/project-registry-wiki-test",
      mappedUsers: ["leo"],
      serverIp: "127.0.0.1",
      cloudflareDns: { enabled: false },
    })
    expect(configR.success).toBe(true)
    if (!configR.success) return
    let reconcileCalls = 0
    const daemonR = projectRegistryDaemonCreate({
      config: configR.data,
      repository,
      caddyApplication: {
        start: async () => createResult({ revision: revisionA, changed: true, applied: true, attempts: 1 }),
        startup: async () => createResult({ revision: revisionA, changed: true, applied: true, attempts: 1 }),
        projectChange: async () => createResult({ revision: revisionA, changed: true, applied: true, attempts: 1 }),
        regenerate: async () => createResult({ revision: revisionA, changed: true, applied: true, attempts: 1 }),
        status: () => ({ pending: false }),
        stop: async () => undefined,
      },
      filesystem,
      serverFactory: (options) => {
        if (options.unix !== undefined) entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
        const server: ProjectRegistryDaemonServer = { stop: () => undefined }
        return server
      },
      posix: {
        isRoot: async () => true,
        userResolve: async () => createResult({ username: "leo", uid: 1000, gid: 1000 }),
      },
      wikiReconcile: async () => {
        reconcileCalls += 1
        return createResult({ processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, skippedMessages: [] })
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    try {
      expect((await daemonR.data.start()).success).toBe(true)
      expect(reconcileCalls).toBe(0)
    } finally {
      await daemonR.data.shutdown()
    }
  })
})
