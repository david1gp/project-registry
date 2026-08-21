import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import { projectAccessLogCaddyRetention } from "../access-log/projectAccessLogCaddyRetention.js"
import { projectAccessLogId } from "../access-log/projectAccessLogId.js"
import { projectAccessLogRetentionMaximumActiveProjectIds } from "../access-log/projectAccessLogRetentionMaximumActiveProjectIds.js"
import { projectAccessLogRetentionReconcile } from "../access-log/projectAccessLogRetentionReconcile.js"
import type { Project } from "../project/Project.js"
import type { ProjectRepositorySnapshot } from "../project-store/ProjectRepositorySnapshot.js"
import { caddyAdminLoad } from "./caddyAdminLoad.js"
import { caddyApplicationCreate } from "./caddyApplicationCreate.js"
import { caddyApplicationQueueCreate } from "./caddyApplicationQueueCreate.js"
import { caddyConfigSerialize } from "./caddyConfigSerialize.js"
import { caddyConfigValidate } from "./caddyConfigValidate.js"
import { caddyProcessRun } from "./caddyProcessRun.js"

function snapshot(revision: string, project: Project = caddyConfigGenerateFixtures.proxy): ProjectRepositorySnapshot {
  return { revision, projects: [structuredClone(project)] }
}

function snapshotProjects(revision: string, projects: readonly Project[]): ProjectRepositorySnapshot {
  return { revision, projects: projects.map((project) => structuredClone(project)) }
}

function timerFake() {
  const intervals: Array<() => void> = []
  let waits = 0
  return {
    timer: {
      wait: async () => {
        waits += 1
      },
      setInterval: (callback: () => void) => {
        intervals.push(callback)
        return callback
      },
      clearInterval: () => undefined,
    },
    intervals,
    waits: () => waits,
  }
}

function timeoutTimerFake() {
  const timeouts: Array<{ callback: () => void; active: boolean }> = []
  return {
    timer: {
      wait: async () => undefined,
      setInterval: (callback: () => void) => callback,
      clearInterval: () => undefined,
      setTimeout: (callback: () => void) => {
        const handle = { callback, active: true }
        timeouts.push(handle)
        return handle
      },
      clearTimeout: (handle: unknown) => {
        if (typeof handle === "object" && handle !== null && "active" in handle) {
          ;(handle as { active: boolean }).active = false
        }
      },
    },
    fireTimeout: () => {
      const handle = timeouts.find((entry) => entry.active)
      if (handle === undefined) return
      handle.active = false
      handle.callback()
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

describe("caddyConfigSerialize", () => {
  test("sorts object keys recursively and preserves array order", () => {
    const result = caddyConfigSerialize({ z: 1, nested: { b: 2, a: 3 }, a: [{ d: 4, c: 5 }] })

    expect(result).toEqual({ success: true, data: '{"a":[{"c":5,"d":4}],"nested":{"a":3,"b":2},"z":1}' })
  })

  test("sorts integer-like keys lexicographically at every object depth", () => {
    const result = caddyConfigSerialize({ "2": "two", "10": "ten", nested: { "2": 2, "10": "ten", "\\": "slash\n" } })

    expect(result).toEqual({
      success: true,
      data: '{"10":"ten","2":"two","nested":{"10":"ten","2":2,"\\\\":"slash\\n"}}',
    })
    if (!result.success) return
    expect(JSON.parse(result.data)).toEqual({
      "2": "two",
      "10": "ten",
      nested: { "2": 2, "10": "ten", "\\": "slash\n" },
    })
  })

  test("preserves ordinary JSON values", () => {
    const result = caddyConfigSerialize({ string: "value", number: 1.5, boolean: true, empty: null, array: [1, "two"] })

    expect(result).toEqual({
      success: true,
      data: '{"array":[1,"two"],"boolean":true,"empty":null,"number":1.5,"string":"value"}',
    })
  })

  test("rejects values JSON.stringify would transform or cannot represent", () => {
    const customPrototype = Object.create({ inherited: true })
    const invalidValues: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(),
      new Map(),
      new Set(),
      customPrototype,
      () => undefined,
      Symbol("secret"),
      undefined,
      1n,
      { value: undefined },
      [undefined],
    ]

    for (const value of invalidValues) expect(caddyConfigSerialize(value).success).toBe(false)
  })

  test("rejects accessors and proxies without invoking them", () => {
    let accessorCalled = false
    const accessor = {}
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => {
        accessorCalled = true
        throw new Error("secret accessor")
      },
    })

    let proxyGetCalled = false
    const proxy = new Proxy(
      { value: 1 },
      {
        get: () => {
          proxyGetCalled = true
          throw new Error("proxy getter")
        },
        getPrototypeOf: () => {
          proxyGetCalled = true
          throw new Error("proxy prototype")
        },
      },
    )

    expect(caddyConfigSerialize(accessor).success).toBe(false)
    expect(caddyConfigSerialize(proxy).success).toBe(false)
    expect(accessorCalled).toBe(false)
    expect(proxyGetCalled).toBe(false)
  })

  test("rejects hidden array entries", () => {
    const value = [1]
    Object.defineProperty(value, "0", { enumerable: false, value: 1 })

    expect(caddyConfigSerialize(value).success).toBe(false)
  })

  test("rejects cyclic values without exposing the value", () => {
    const value: Record<string, unknown> = {}
    value.value = value

    const result = caddyConfigSerialize(value)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("Caddy configuration is not serializable")
  })
})

describe("caddyConfigValidate", () => {
  test("passes canonical JSON to the injected Caddy process", async () => {
    let received: { command: string; args: readonly string[]; input: string } | undefined
    const result = await caddyConfigValidate(
      { z: 1, a: 2 },
      {
        caddyBin: "/usr/bin/caddy",
        processRunner: async (command, args, input) => {
          received = { command, args, input }
          return createResult({ exitCode: 0, stdout: "", stderr: "" })
        },
      },
    )

    expect(result).toEqual({ success: true, data: true })
    expect(received).toEqual({
      command: "/usr/bin/caddy",
      args: ["validate", "--config", "-", "--adapter", ""],
      input: '{"a":2,"z":1}',
    })
  })

  test("sanitizes validation failures", async () => {
    const result = await caddyConfigValidate(
      {},
      {
        processRunner: async () => createResult({ exitCode: 1, stdout: "secret", stderr: "secret" }),
      },
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("caddy validate failed (exit code 1)")
    expect(result.errorMessage).not.toContain("secret")
  })

  test("rejects malformed process results without exposing arbitrary fields", async () => {
    const malformedResults: unknown[] = [
      null,
      {},
      { success: true },
      { success: true, data: {} },
      { success: true, data: { exitCode: "secret", stdout: "secret", stderr: "secret" } },
      { success: false, op: "secret", errorMessage: "secret" },
    ]

    for (const malformed of malformedResults) {
      const result = await caddyConfigValidate({}, { processRunner: async () => malformed as never })

      expect(result).toEqual({
        success: false,
        op: "caddyConfigValidate",
        errorMessage: "caddy validate process failed",
      })
    }

    let getterCalled = false
    const data = {}
    Object.defineProperty(data, "exitCode", {
      enumerable: true,
      get: () => {
        getterCalled = true
        throw new Error("secret getter")
      },
    })
    const getterResult = await caddyConfigValidate(
      {},
      {
        processRunner: async () => ({ success: true, data }) as never,
      },
    )

    expect(getterResult).toEqual({
      success: false,
      op: "caddyConfigValidate",
      errorMessage: "caddy validate process failed",
    })
    expect(getterCalled).toBe(false)
  })

  test("validates timeout and aborts a never-settling process runner", async () => {
    const fakeTimer = timeoutTimerFake()
    let signal: AbortSignal | null | undefined
    const resultPromise = caddyConfigValidate(
      {},
      {
        timeoutMs: 5,
        timer: fakeTimer.timer,
        processRunner: async (_command, _args, _input, options) => {
          signal = options?.signal
          return new Promise(() => undefined)
        },
      },
    )

    await Promise.resolve()
    fakeTimer.fireTimeout()
    const result = await resultPromise

    expect(result).toEqual({ success: false, op: "caddyConfigValidate", errorMessage: "caddy validate timed out" })
    expect(signal?.aborted).toBe(true)
  })

  test("rejects invalid validation timeouts", async () => {
    const result = await caddyConfigValidate({}, { timeoutMs: 0 })

    expect(result).toEqual({
      success: false,
      op: "caddyConfigValidate",
      errorMessage: "Caddy validate timeout is invalid",
    })
  })

  test("returns a failed Result for malformed runtime options", async () => {
    const result = await caddyConfigValidate({}, null)

    expect(result).toEqual({
      success: false,
      op: "caddyConfigValidate",
      errorMessage: "Caddy validate options are invalid",
    })
  })
})

describe("caddyAdminLoad", () => {
  test("posts canonical JSON to the admin load endpoint", async () => {
    let request: { input: string; init: RequestInit } | undefined
    const result = await caddyAdminLoad(
      { z: 1, a: 2 },
      {
        adminUrl: "http://caddy.test///",
        fetch: async (input, init) => {
          request = { input, init }
          return new Response("", { status: 200 })
        },
      },
    )

    expect(result).toEqual({ success: true, data: true })
    expect(request?.input).toBe("http://caddy.test/load")
    expect(request?.init.method).toBe("POST")
    expect(request?.init.body).toBe('{"a":2,"z":1}')
  })

  test("sanitizes load failures", async () => {
    const result = await caddyAdminLoad(
      {},
      { fetch: async () => new Response("secret", { status: 500, statusText: "secret" }) },
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("caddy admin load failed (status 500)")
    expect(result.errorMessage).not.toContain("secret")
  })

  test("rejects malformed responses without exposing arbitrary fields", async () => {
    const malformedResponses: unknown[] = [
      null,
      {},
      { ok: true },
      { ok: true, status: "secret" },
      { ok: true, status: 99 },
      { ok: false, status: "secret", error: "secret" },
    ]

    for (const malformed of malformedResponses) {
      const result = await caddyAdminLoad({}, { fetch: async () => malformed as never })

      expect(result).toEqual({
        success: false,
        op: "caddyAdminLoad",
        errorMessage: "caddy admin load request failed",
      })
    }

    let getterCalled = false
    const response = {}
    Object.defineProperty(response, "ok", {
      enumerable: true,
      get: () => {
        getterCalled = true
        throw new Error("secret getter")
      },
    })
    Object.defineProperty(response, "status", { enumerable: true, value: 200 })
    const getterResult = await caddyAdminLoad({}, { fetch: async () => response as never })

    expect(getterResult).toEqual({
      success: false,
      op: "caddyAdminLoad",
      errorMessage: "caddy admin load request failed",
    })
    expect(getterCalled).toBe(false)
  })

  test("rejects responses whose ok flag contradicts their status", async () => {
    for (const response of [
      { ok: true, status: 500 },
      { ok: false, status: 200 },
    ]) {
      const result = await caddyAdminLoad({}, { fetch: async () => response as never })

      expect(result).toEqual({
        success: false,
        op: "caddyAdminLoad",
        errorMessage: "caddy admin load request failed",
      })
    }
  })

  test("times out and aborts a never-settling admin load", async () => {
    const fakeTimer = timeoutTimerFake()
    let signal: AbortSignal | null | undefined
    const resultPromise = caddyAdminLoad(
      {},
      {
        timeoutMs: 5,
        timer: fakeTimer.timer,
        fetch: async (_input, init) => {
          signal = init.signal
          return new Promise<Response>(() => undefined)
        },
      },
    )

    await Promise.resolve()
    fakeTimer.fireTimeout()
    const result = await resultPromise

    expect(result).toEqual({ success: false, op: "caddyAdminLoad", errorMessage: "caddy admin load timed out" })
    expect(signal?.aborted).toBe(true)
  })

  test("rejects invalid admin load timeouts", async () => {
    const result = await caddyAdminLoad({}, { timeoutMs: 0 })

    expect(result).toEqual({
      success: false,
      op: "caddyAdminLoad",
      errorMessage: "Caddy admin load timeout is invalid",
    })
  })

  test("returns a failed Result for malformed runtime options", async () => {
    const result = await caddyAdminLoad({}, null)

    expect(result).toEqual({
      success: false,
      op: "caddyAdminLoad",
      errorMessage: "Caddy admin load options are invalid",
    })
  })
})

describe("caddyProcessRun", () => {
  test("terminates and reaps a process at its timeout", async () => {
    const result = await caddyProcessRun("bun", ["-e", "await new Promise(() => undefined)"], "", { timeoutMs: 10 })

    expect(result).toEqual({ success: false, op: "caddyProcessRun", errorMessage: "Caddy process execution timed out" })
  })

  test("returns a failed Result for malformed runtime options", async () => {
    const result = await caddyProcessRun("bun", [], "", null)

    expect(result).toEqual({
      success: false,
      op: "caddyProcessRun",
      errorMessage: "Caddy process options are invalid",
    })
  })
})

describe("caddyApplication", () => {
  test("returns a failed Result for malformed runtime options", () => {
    expect(caddyApplicationCreate(null)).toEqual({
      success: false,
      op: "caddyApplicationCreate",
      errorMessage: "Caddy application options are invalid",
    })
    expect(caddyApplicationCreate({ repository: null })).toEqual({
      success: false,
      op: "caddyApplicationCreate",
      errorMessage: "Caddy application options are invalid",
    })
    expect(
      caddyApplicationCreate({
        repository: { read: async () => createResult(snapshot("revision")) },
        initializeFromGeneratedConfig: "true",
      } as never),
    ).toEqual({
      success: false,
      op: "caddyApplicationCreate",
      errorMessage: "initializeFromGeneratedConfig must be a boolean",
    })
  })

  test("does not invoke an application option accessor", () => {
    let called = false
    const options = {}
    Object.defineProperty(options, "repository", {
      enumerable: true,
      get: () => {
        called = true
        throw new Error("repository accessor")
      },
    })

    const result = caddyApplicationCreate(options)

    expect(result.success).toBe(false)
    expect(called).toBe(false)
  })

  test("loads a valid configuration and reports the applied revision", async () => {
    let validates = 0
    let loads = 0
    const fakeTimer = timerFake()
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-1")) },
      clock: () => 100,
      timer: fakeTimer.timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const result = await applicationR.data.start()

    expect(result).toEqual({
      success: true,
      data: { revision: "revision-1", changed: true, applied: true, attempts: 1 },
    })
    expect(validates).toBe(1)
    expect(loads).toBe(1)
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-1",
      appliedRevision: "revision-1",
      pending: false,
      lastAttempt: 100,
      lastSuccess: 100,
    })
    expect(fakeTimer.intervals).toHaveLength(1)
    applicationR.data.stop()
  })

  test("reconciles inactive access-log directories only after a successful load", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-"))
    const oldId = projectAccessLogId({ owner: "deleted-owner", name: "deleted-project" })
    const oldDirectory = join(root, "projects", oldId)
    try {
      await mkdir(oldDirectory, { recursive: true })
      await writeFile(join(oldDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshot("revision-retention-success")) },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => new Response("", { status: 200 }),
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      expect((await applicationR.data.start()).success).toBe(true)
      await expect(lstat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" })
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("retries transient retention failure on an unchanged interval without reloading Caddy", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-retry-"))
    const projectsPath = join(root, "projects")
    const oldId = projectAccessLogId({ owner: "retry-owner", name: "retry-project" })
    const oldDirectory = join(projectsPath, oldId)
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    const fakeTimer = timerFake()
    let validates = 0
    let loads = 0
    try {
      await writeFile(projectsPath, "transient failure")
      expect(
        (await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: retentionNow })).success,
      ).toBe(false)
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshot("revision-retention-retry")) },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => retentionNow,
        timer: fakeTimer.timer,
        processRunner: async () => {
          validates += 1
          return createResult({ exitCode: 0, stdout: "", stderr: "" })
        },
        fetch: async () => {
          loads += 1
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      expect((await applicationR.data.start()).success).toBe(true)
      expect(validates).toBe(1)
      expect(loads).toBe(1)

      await rm(projectsPath)
      await mkdir(oldDirectory, { recursive: true })
      await writeFile(join(oldDirectory, "access.jsonl"), "")
      await writeFile(
        join(oldDirectory, ".project-registry-retention.json"),
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )
      fakeTimer.intervals[0]?.()
      let quarantined = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          quarantined = (await lstat(join(root, "quarantine", oldId))).isDirectory()
        } catch {
          quarantined = false
        }
        if (quarantined) break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      expect(validates).toBe(1)
      expect(loads).toBe(1)
      expect(quarantined).toBe(true)
      await expect(lstat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" })
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not pass a partial active set when Caddy has over-limit active projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-over-limit-"))
    const oldId = projectAccessLogId({ owner: "over-limit-owner", name: "deleted-project" })
    const oldDirectory = join(root, "projects", oldId)
    const projects = Array.from({ length: projectAccessLogRetentionMaximumActiveProjectIds + 1 }, (_, index) => ({
      ...structuredClone(caddyConfigGenerateFixtures.proxy),
      name: `retention-${index}`,
      caddy: {
        ...structuredClone(caddyConfigGenerateFixtures.proxy.caddy),
        domains: [`retention-${index}.example`],
        port: 4096 + index,
      },
    }))
    try {
      await mkdir(oldDirectory, { recursive: true })
      await writeFile(join(oldDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshotProjects("revision-retention-over-limit", projects)) },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => new Response("", { status: 200 }),
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      expect((await applicationR.data.start()).success).toBe(true)
      expect((await lstat(oldDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(oldDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not reconcile after a failed Caddy load", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-failed-"))
    const oldId = projectAccessLogId({ owner: "failed-owner", name: "failed-project" })
    const oldDirectory = join(root, "projects", oldId)
    try {
      await mkdir(oldDirectory, { recursive: true })
      await writeFile(join(oldDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshot("revision-retention-failed")) },
        configOptions: { caddyAccessLogRoot: root },
        maxRetries: 0,
        clock: () => projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => new Response("", { status: 503 }),
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      expect((await applicationR.data.start()).success).toBe(false)
      expect((await lstat(oldDirectory)).isDirectory()).toBe(true)
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not reconcile after Caddy validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-validation-"))
    const oldId = projectAccessLogId({ owner: "validation-owner", name: "validation-project" })
    const oldDirectory = join(root, "projects", oldId)
    try {
      await mkdir(oldDirectory, { recursive: true })
      await writeFile(join(oldDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })
      let loads = 0
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshot("revision-retention-validation")) },
        configOptions: { caddyAccessLogRoot: root },
        maxRetries: 0,
        clock: () => projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 1, stdout: "", stderr: "" }),
        fetch: async () => {
          loads += 1
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      expect((await applicationR.data.start()).success).toBe(false)
      expect(loads).toBe(0)
      expect((await lstat(oldDirectory)).isDirectory()).toBe(true)
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not reconcile an older successful load while a newer desired revision is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-stale-"))
    const latestProject = caddyConfigGenerateFixtures.static
    const latestProjectDirectory = join(root, "projects", projectAccessLogId(latestProject))
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    const firstLoad = deferred<Response>()
    const firstLoadStarted = deferred<void>()
    const snapshots = [
      snapshot("revision-retention-old", caddyConfigGenerateFixtures.proxy),
      snapshot("revision-retention-pending", { ...caddyConfigGenerateFixtures.proxy, description: "metadata only" }),
      snapshotProjects("revision-retention-latest", [caddyConfigGenerateFixtures.proxy, latestProject]),
    ]
    let loads = 0
    try {
      await mkdir(latestProjectDirectory, { recursive: true })
      await writeFile(join(latestProjectDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })

      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshots.shift() ?? snapshots[2]) },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => retentionNow,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => {
          loads += 1
          if (loads === 1) {
            firstLoadStarted.resolve()
            return firstLoad.promise
          }
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      const first = applicationR.data.projectChange()
      await firstLoadStarted.promise
      const second = applicationR.data.projectChange()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(applicationR.data.status()).toMatchObject({
        desiredRevision: "revision-retention-pending",
        pendingRevision: "revision-retention-pending",
        pending: true,
      })

      firstLoad.resolve(new Response("", { status: 200 }))
      const results = await Promise.all([first, second])
      expect(results[0]).toMatchObject({ success: true, data: { revision: "revision-retention-pending" } })
      expect(results[1]).toEqual(results[0])
      expect((await lstat(latestProjectDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(latestProjectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )

      expect((await applicationR.data.projectChange()).success).toBe(true)
      expect(await readFile(join(latestProjectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"active"}',
      )
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not reconcile while a newer repository read is pending and reconciles its snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-pending-read-"))
    const project = caddyConfigGenerateFixtures.proxy
    const projectId = projectAccessLogId(project)
    const projectDirectory = join(root, "projects", projectId)
    const metadataPath = join(projectDirectory, ".project-registry-retention.json")
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    const newerRead = deferred<Result<ProjectRepositorySnapshot>>()
    const newerReadStarted = deferred<void>()
    let application: (() => void) | undefined
    let reads = 0
    let loads = 0
    try {
      await mkdir(projectDirectory, { recursive: true })
      await writeFile(join(projectDirectory, "access.jsonl"), "")

      const applicationR = caddyApplicationCreate({
        repository: {
          read: async () => {
            reads += 1
            if (reads === 1) return createResult(snapshotProjects("revision-retention-old-pending-read", []))
            newerReadStarted.resolve()
            return newerRead.promise
          },
        },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => retentionNow,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => {
          loads += 1
          if (loads === 1) application?.()
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return
      application = () => {
        void applicationR.data.projectChange()
      }

      const resultPromise = applicationR.data.start()
      await newerReadStarted.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reads).toBe(2)
      expect(loads).toBe(1)
      expect(applicationR.data.status()).toMatchObject({
        desiredRevision: "revision-retention-old-pending-read",
        appliedRevision: "revision-retention-old-pending-read",
        pending: false,
      })
      await projectAccessLogRetentionReconcile({
        root,
        activeProjectIds: [projectId],
        now: retentionNow,
        stillCurrent: () => false,
      })
      await expect(readFile(metadataPath)).rejects.toMatchObject({ code: "ENOENT" })

      newerRead.resolve(createResult(snapshot("revision-retention-new-pending-read", project)))
      const result = await resultPromise

      expect(result).toMatchObject({
        success: true,
        data: { revision: "revision-retention-new-pending-read", applied: true },
      })
      expect(await readFile(metadataPath, "utf8")).toBe('{"version":1,"state":"active"}')
      expect(reads).toBe(2)
      expect(loads).toBe(2)
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("abandons stale retention for a reactivation that arrives during reconciliation and drains it", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-await-race-"))
    const project = caddyConfigGenerateFixtures.proxy
    const projectId = projectAccessLogId(project)
    const projectDirectory = join(root, "projects", projectId)
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    const noiseCount = 256
    let application: (() => void) | undefined
    let reads = 0
    let loads = 0
    try {
      await mkdir(join(root, "projects"), { recursive: true })
      for (let index = 0; index < noiseCount; index += 1) {
        const noiseDirectory = join(root, "projects", projectAccessLogId({ owner: "noise", name: `project-${index}` }))
        await mkdir(noiseDirectory)
        await writeFile(join(noiseDirectory, "access.jsonl"), "")
        await writeFile(
          join(noiseDirectory, ".project-registry-retention.json"),
          '{"version":1,"state":"inactive","inactiveAt":0}',
        )
      }
      await mkdir(projectDirectory)
      await writeFile(join(projectDirectory, "access.jsonl"), "")
      await writeFile(
        join(projectDirectory, ".project-registry-retention.json"),
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )

      const applicationR = caddyApplicationCreate({
        repository: {
          read: async () => {
            reads += 1
            return reads === 1
              ? createResult(snapshotProjects("revision-retention-await-old", []))
              : createResult(snapshot("revision-retention-await-reactivated", project))
          },
        },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => retentionNow,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => {
          loads += 1
          if (loads === 1) setTimeout(() => application?.(), 0)
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return
      application = () => {
        void applicationR.data.projectChange()
      }

      const result = await applicationR.data.start()

      expect(result).toMatchObject({
        success: true,
        data: { revision: "revision-retention-await-reactivated", applied: true },
      })
      expect(reads).toBe(2)
      expect((await lstat(projectDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(projectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"active"}',
      )
      await expect(lstat(join(root, "quarantine", projectId))).rejects.toMatchObject({ code: "ENOENT" })
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not write stale live metadata when a newer desired state arrives during reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-write-race-"))
    const project = caddyConfigGenerateFixtures.proxy
    const projectId = projectAccessLogId(project)
    const projectDirectory = join(root, "projects", projectId)
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    const secondLoad = deferred<Response>()
    const secondLoadStarted = deferred<void>()
    const noiseCount = 256
    let application: (() => void) | undefined
    let reads = 0
    let loads = 0
    try {
      await mkdir(join(root, "projects"), { recursive: true })
      for (let index = 0; index < noiseCount; index += 1) {
        const noiseDirectory = join(
          root,
          "projects",
          projectAccessLogId({ owner: "write-noise", name: `project-${index}` }),
        )
        await mkdir(noiseDirectory)
        await writeFile(join(noiseDirectory, "access.jsonl"), "")
        await writeFile(
          join(noiseDirectory, ".project-registry-retention.json"),
          '{"version":1,"state":"inactive","inactiveAt":0}',
        )
      }
      await mkdir(projectDirectory)
      await writeFile(join(projectDirectory, "access.jsonl"), "")

      const applicationR = caddyApplicationCreate({
        repository: {
          read: async () => {
            reads += 1
            return reads === 1
              ? createResult(snapshotProjects("revision-retention-write-old", []))
              : createResult(snapshot("revision-retention-write-new", project))
          },
        },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => retentionNow,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => {
          loads += 1
          if (loads === 1) {
            setTimeout(() => application?.(), 0)
            return new Response("", { status: 200 })
          }
          secondLoadStarted.resolve()
          return secondLoad.promise
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return
      application = () => {
        void applicationR.data.projectChange()
      }

      const resultPromise = applicationR.data.start()
      await secondLoadStarted.promise
      await expect(readFile(join(projectDirectory, ".project-registry-retention.json"))).rejects.toMatchObject({
        code: "ENOENT",
      })

      secondLoad.resolve(new Response("", { status: 200 }))
      const result = await resultPromise
      expect(result).toMatchObject({
        success: true,
        data: { revision: "revision-retention-write-new", applied: true },
      })
      expect(await readFile(join(projectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"active"}',
      )
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("defers retention reconciliation until a queued reactivation is applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-reactivation-validation-"))
    const project = caddyConfigGenerateFixtures.proxy
    const projectId = projectAccessLogId(project)
    const projectDirectory = join(root, "projects", projectId)
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    const firstValidation = deferred<Result<ProcessResult>>()
    const firstValidationStarted = deferred<void>()
    const secondValidation = deferred<Result<ProcessResult>>()
    const secondValidationStarted = deferred<void>()
    const secondRead = deferred<Result<ProjectRepositorySnapshot>>()
    const secondReadStarted = deferred<void>()
    let reads = 0
    let validations = 0
    try {
      await mkdir(projectDirectory, { recursive: true })
      await writeFile(join(projectDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })

      const applicationR = caddyApplicationCreate({
        repository: {
          read: async () => {
            reads += 1
            if (reads === 2) {
              secondReadStarted.resolve()
              return secondRead.promise
            }
            return createResult(snapshotProjects("revision-reactivation-inactive", []))
          },
        },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => retentionNow,
        timer: timerFake().timer,
        processRunner: async () => {
          validations += 1
          if (validations === 1) {
            firstValidationStarted.resolve()
            return firstValidation.promise
          }
          secondValidationStarted.resolve()
          return secondValidation.promise
        },
        fetch: async () => new Response("", { status: 200 }),
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      const first = applicationR.data.projectChange()
      await firstValidationStarted.promise

      const second = applicationR.data.projectChange()
      await secondReadStarted.promise
      secondRead.resolve(createResult(snapshot("revision-reactivation-active", project)))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(applicationR.data.status()).toMatchObject({
        pendingRevision: "revision-reactivation-active",
        pending: true,
      })

      firstValidation.resolve(createResult({ exitCode: 0, stdout: "", stderr: "" }))
      await secondValidationStarted.promise
      expect((await lstat(projectDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(projectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )

      secondValidation.resolve(createResult({ exitCode: 0, stdout: "", stderr: "" }))
      const results = await Promise.all([first, second])
      expect(results[0]).toMatchObject({ success: true, data: { revision: "revision-reactivation-active" } })
      expect(results[1]).toEqual(results[0])
      expect(await readFile(join(projectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"active"}',
      )
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("defers retention reconciliation while a queued reactivation waits for Caddy load", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-reactivation-load-"))
    const project = caddyConfigGenerateFixtures.proxy
    const projectId = projectAccessLogId(project)
    const projectDirectory = join(root, "projects", projectId)
    const firstLoad = deferred<Response>()
    const secondLoad = deferred<Response>()
    const firstLoadStarted = deferred<void>()
    const secondLoadStarted = deferred<void>()
    const secondRead = deferred<Result<ProjectRepositorySnapshot>>()
    const secondReadStarted = deferred<void>()
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    let reads = 0
    let loads = 0
    try {
      await mkdir(projectDirectory, { recursive: true })
      await writeFile(join(projectDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })

      const applicationR = caddyApplicationCreate({
        repository: {
          read: async () => {
            reads += 1
            if (reads === 2) {
              secondReadStarted.resolve()
              return secondRead.promise
            }
            return createResult(snapshotProjects("revision-reactivation-inactive-load", []))
          },
        },
        configOptions: { caddyAccessLogRoot: root },
        clock: () => retentionNow,
        timer: timerFake().timer,
        processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
        fetch: async () => {
          loads += 1
          if (loads === 1) {
            firstLoadStarted.resolve()
            return firstLoad.promise
          }
          secondLoadStarted.resolve()
          return secondLoad.promise
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      const first = applicationR.data.projectChange()
      await firstLoadStarted.promise
      const second = applicationR.data.projectChange()
      await secondReadStarted.promise
      secondRead.resolve(createResult(snapshot("revision-reactivation-active-load", project)))
      await new Promise((resolve) => setTimeout(resolve, 0))

      firstLoad.resolve(new Response("", { status: 200 }))
      await secondLoadStarted.promise
      expect((await lstat(projectDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(projectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )

      secondLoad.resolve(new Response("", { status: 200 }))
      const results = await Promise.all([first, second])
      expect(results[0]).toMatchObject({ success: true, data: { revision: "revision-reactivation-active-load" } })
      expect(results[1]).toEqual(results[0])
      expect(await readFile(join(projectDirectory, ".project-registry-retention.json"), "utf8")).toBe(
        '{"version":1,"state":"active"}',
      )
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("initializes from a validated configuration without loading Caddy", async () => {
    let currentProject: Project = caddyConfigGenerateFixtures.proxy
    let validates = 0
    let loads = 0
    const fakeTimer = timerFake()
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-1", currentProject)) },
      initializeFromGeneratedConfig: true,
      timer: fakeTimer.timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const initialized = await applicationR.data.startup()

    expect(initialized).toEqual({
      success: true,
      data: { revision: "revision-1", changed: false, applied: true, attempts: 1 },
    })
    expect(validates).toBe(1)
    expect(loads).toBe(0)
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-1",
      appliedRevision: "revision-1",
      pending: false,
    })

    fakeTimer.intervals[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(validates).toBe(1)
    expect(loads).toBe(0)

    currentProject = caddyConfigGenerateFixtures.static
    fakeTimer.intervals[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(validates).toBe(2)
    expect(loads).toBe(1)

    expect((await applicationR.data.regenerate()).success).toBe(true)
    expect(validates).toBe(3)
    expect(loads).toBe(2)
    await applicationR.data.stop()
  })

  test("reconciles expired access-log directories after startup initialization without loading Caddy", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-startup-"))
    const oldId = projectAccessLogId({ owner: "startup-deleted-owner", name: "startup-deleted-project" })
    const oldDirectory = join(root, "projects", oldId)
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    let validates = 0
    let loads = 0
    try {
      await mkdir(oldDirectory, { recursive: true })
      await writeFile(join(oldDirectory, "access.jsonl"), "")
      await projectAccessLogRetentionReconcile({ root, activeProjectIds: [], now: 0 })
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshot("revision-retention-startup")) },
        configOptions: { caddyAccessLogRoot: root },
        initializeFromGeneratedConfig: true,
        clock: () => retentionNow,
        timer: timerFake().timer,
        processRunner: async () => {
          validates += 1
          return createResult({ exitCode: 0, stdout: "", stderr: "" })
        },
        fetch: async () => {
          loads += 1
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      expect(await applicationR.data.startup()).toMatchObject({
        success: true,
        data: { revision: "revision-retention-startup", changed: false, applied: true },
      })
      expect(validates).toBe(1)
      expect(loads).toBe(0)
      await expect(lstat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" })
      expect((await lstat(join(root, "quarantine", oldId))).isDirectory()).toBe(true)
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("retries failed startup retention on an unchanged interval without loading Caddy", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-caddy-retention-startup-retry-"))
    const projectsPath = join(root, "projects")
    const oldId = projectAccessLogId({ owner: "startup-retry-owner", name: "startup-retry-project" })
    const oldDirectory = join(projectsPath, oldId)
    const retentionNow = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1
    const fakeTimer = timerFake()
    let validates = 0
    let loads = 0
    try {
      await writeFile(projectsPath, "transient startup failure")
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult(snapshot("revision-retention-startup-retry")) },
        configOptions: { caddyAccessLogRoot: root },
        initializeFromGeneratedConfig: true,
        clock: () => retentionNow,
        timer: fakeTimer.timer,
        processRunner: async () => {
          validates += 1
          return createResult({ exitCode: 0, stdout: "", stderr: "" })
        },
        fetch: async () => {
          loads += 1
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) return

      expect((await applicationR.data.startup()).success).toBe(true)
      expect(validates).toBe(1)
      expect(loads).toBe(0)

      await rm(projectsPath)
      await mkdir(oldDirectory, { recursive: true })
      await writeFile(join(oldDirectory, "access.jsonl"), "")
      await writeFile(
        join(oldDirectory, ".project-registry-retention.json"),
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )
      fakeTimer.intervals[0]?.()
      let quarantined = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          quarantined = (await lstat(join(root, "quarantine", oldId))).isDirectory()
        } catch {
          quarantined = false
        }
        if (quarantined) break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      expect(validates).toBe(1)
      expect(loads).toBe(0)
      expect(quarantined).toBe(true)
      await expect(lstat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" })
      await applicationR.data.stop()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("keeps an invalid initialization pending for interval retry", async () => {
    let validates = 0
    let loads = 0
    const fakeTimer = timerFake()
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-invalid")) },
      initializeFromGeneratedConfig: true,
      maxRetries: 0,
      timer: fakeTimer.timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: validates === 1 ? 1 : 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const initialized = await applicationR.data.startup()

    expect(initialized).toEqual({
      success: true,
      data: { revision: "revision-invalid", changed: false, applied: false, attempts: 1 },
    })
    expect(loads).toBe(0)
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-invalid",
      pendingRevision: "revision-invalid",
      pending: true,
      error: "caddy validate failed (exit code 1)",
    })
    expect(applicationR.data.status().appliedRevision).toBeUndefined()

    fakeTimer.intervals[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(validates).toBe(2)
    expect(loads).toBe(1)
    expect(applicationR.data.status()).toMatchObject({
      appliedRevision: "revision-invalid",
      pending: false,
      error: undefined,
    })
    await applicationR.data.stop()
  })

  test("does not reload unchanged interval configurations but applies real changes", async () => {
    let currentProject: Project = caddyConfigGenerateFixtures.proxy
    let validates = 0
    let loads = 0
    const fakeTimer = timerFake()
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-1", currentProject)) },
      timer: fakeTimer.timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    expect((await applicationR.data.start()).success).toBe(true)
    expect(validates).toBe(1)
    expect(loads).toBe(1)

    fakeTimer.intervals[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(validates).toBe(1)
    expect(loads).toBe(1)

    currentProject = caddyConfigGenerateFixtures.static
    fakeTimer.intervals[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(validates).toBe(2)
    expect(loads).toBe(2)
    await applicationR.data.stop()
  })

  test("retries validation and then loads once", async () => {
    let validates = 0
    let loads = 0
    const fakeTimer = timerFake()
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-1")) },
      maxRetries: 1,
      retryDelayMs: 5,
      timer: fakeTimer.timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: validates === 1 ? 1 : 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const result = await applicationR.data.regenerate()

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.attempts).toBe(2)
    expect(validates).toBe(2)
    expect(loads).toBe(1)
    expect(fakeTimer.waits()).toBe(1)
  })

  test("keeps the desired revision pending when validation never succeeds", async () => {
    let loads = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-invalid")) },
      maxRetries: 1,
      timer: timerFake().timer,
      processRunner: async () => createResult({ exitCode: 1, stdout: "", stderr: "" }),
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const result = await applicationR.data.projectChange()

    expect(result.success).toBe(false)
    expect(loads).toBe(0)
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-invalid",
      pendingRevision: "revision-invalid",
      pending: true,
      error: "caddy validate failed (exit code 1)",
    })
  })

  test("leaves the last valid revision applied after bounded load failures", async () => {
    let current = snapshot("revision-1")
    let loads = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(current) },
      maxRetries: 1,
      timer: timerFake().timer,
      processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
      fetch: async () => {
        loads += 1
        return new Response("", { status: loads === 1 ? 200 : 503 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    expect((await applicationR.data.regenerate()).success).toBe(true)
    current = snapshot("revision-2", {
      ...caddyConfigGenerateFixtures.proxy,
      caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, port: 4097 },
    })
    const result = await applicationR.data.projectChange()

    expect(result.success).toBe(false)
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-2",
      appliedRevision: "revision-1",
      pendingRevision: "revision-2",
      pending: true,
      error: "caddy admin load failed (status 503)",
    })
    expect(loads).toBe(3)
  })

  test("advances metadata-only revisions without reloading", async () => {
    let current = snapshot("revision-1")
    let validates = 0
    let loads = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(current) },
      timer: timerFake().timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    expect((await applicationR.data.regenerate()).success).toBe(true)
    expect((await applicationR.data.regenerate()).success).toBe(true)
    current = snapshot("revision-2", { ...caddyConfigGenerateFixtures.proxy, description: "metadata only" })
    const result = await applicationR.data.projectChange()

    expect(result).toEqual({
      success: true,
      data: { revision: "revision-2", changed: false, applied: true, attempts: 0 },
    })
    expect(validates).toBe(2)
    expect(loads).toBe(2)
    expect(applicationR.data.status()).toMatchObject({ appliedRevision: "revision-2", pending: false })
  })

  test("coalesces concurrent triggers while keeping the queue serialized", async () => {
    const snapshots = [snapshot("revision-1"), snapshot("revision-2", caddyConfigGenerateFixtures.static)]
    let validates = 0
    let loads = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshots.shift() ?? snapshot("revision-last")) },
      timer: timerFake().timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const first = applicationR.data.projectChange()
    const second = applicationR.data.projectChange()
    const results = await Promise.all([first, second])

    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ success: true, data: { revision: "revision-2" } })
    expect(validates).toBe(1)
    expect(loads).toBe(1)
  })

  test("ignores an older read that completes after a newer trigger", async () => {
    const firstRead = deferred<Result<ProjectRepositorySnapshot>>()
    const secondRead = deferred<Result<ProjectRepositorySnapshot>>()
    const pendingReads = [firstRead, secondRead]
    let validates = 0
    let loads = 0
    const applicationR = caddyApplicationCreate({
      repository: {
        read: () => pendingReads.shift()?.promise ?? Promise.resolve(createResult(snapshot("revision-last"))),
      },
      timer: timerFake().timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const first = applicationR.data.projectChange()
    const second = applicationR.data.projectChange()
    await Promise.resolve()
    await Promise.resolve()

    secondRead.resolve(createResult(snapshot("revision-2", caddyConfigGenerateFixtures.static)))
    await Promise.resolve()
    firstRead.resolve(createResult(snapshot("revision-1")))

    const results = await Promise.all([first, second])

    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ success: true, data: { revision: "revision-2" } })
    expect(validates).toBe(1)
    expect(loads).toBe(1)
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-2",
      appliedRevision: "revision-2",
      pending: false,
      pendingRevision: undefined,
    })
  })

  test("clears pending after an older application succeeds behind a newer read failure", async () => {
    const firstValidation = deferred<Result<ProcessResult>>()
    const validationStarted = deferred<void>()
    const newerRead = deferred<Result<ProjectRepositorySnapshot>>()
    const newerReadStarted = deferred<void>()
    let reads = 0
    let validations = 0
    const applicationR = caddyApplicationCreate({
      repository: {
        read: async () => {
          reads += 1
          if (reads === 2) {
            newerReadStarted.resolve()
            return newerRead.promise
          }
          return createResult(snapshot("revision-1"))
        },
      },
      timer: timerFake().timer,
      processRunner: async () => {
        validations += 1
        if (validations === 1) {
          validationStarted.resolve()
          return firstValidation.promise
        }
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const first = applicationR.data.projectChange()
    await validationStarted.promise
    const second = applicationR.data.projectChange()
    await newerReadStarted.promise
    newerRead.resolve(createResultError("projectRepositoryRead", "secret read failure"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-1",
      pendingRevision: "revision-1",
      pending: true,
      error: "project registry read failed",
    })

    firstValidation.resolve(createResult({ exitCode: 0, stdout: "", stderr: "" }))
    const results = await Promise.all([first, second])

    expect(results).toEqual([
      { success: false, op: "caddyApplication", errorMessage: "project registry read failed" },
      { success: false, op: "caddyApplication", errorMessage: "project registry read failed" },
    ])
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-1",
      appliedRevision: "revision-1",
      pending: false,
      pendingRevision: undefined,
      error: "project registry read failed",
    })
  })

  test("reports a newer revision while an older application is active", async () => {
    const firstValidation = deferred<Result<ProcessResult>>()
    const validationStarted = deferred<void>()
    const secondRead = deferred<Result<ProjectRepositorySnapshot>>()
    const secondReadStarted = deferred<void>()
    let reads = 0
    let validates = 0
    const applicationR = caddyApplicationCreate({
      repository: {
        read: async () => {
          reads += 1
          if (reads === 2) {
            secondReadStarted.resolve()
            return secondRead.promise
          }
          return createResult(snapshot(`revision-${reads}`))
        },
      },
      timer: timerFake().timer,
      processRunner: async () => {
        validates += 1
        if (validates === 1) {
          validationStarted.resolve()
          return firstValidation.promise
        }
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const first = applicationR.data.projectChange()
    await validationStarted.promise
    const second = applicationR.data.projectChange()
    await secondReadStarted.promise
    secondRead.resolve(createResult(snapshot("revision-2", caddyConfigGenerateFixtures.static)))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-2",
      pendingRevision: "revision-2",
      pending: true,
    })

    firstValidation.resolve(createResult({ exitCode: 0, stdout: "", stderr: "" }))
    const results = await Promise.all([first, second])

    expect(results[0]).toMatchObject({ success: true, data: { revision: "revision-2" } })
    expect(results[1]).toEqual(results[0])
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-2",
      appliedRevision: "revision-2",
      pending: false,
    })
  })

  test("updates status when the repository read fails", async () => {
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResultError("projectRepositoryRead", "read failed") },
      timer: timerFake().timer,
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const result = await applicationR.data.projectChange()

    expect(result).toEqual({ success: false, op: "caddyApplication", errorMessage: "project registry read failed" })
    expect(applicationR.data.status()).toEqual({ pending: false, error: "project registry read failed" })
  })

  test("rejects malformed repository read results without applying config", async () => {
    const malformedResults: unknown[] = [
      null,
      {},
      { success: true },
      { success: true, data: { revision: "revision-secret", projects: "secret" } },
      { success: "true", data: { revision: "revision-secret", projects: [] } },
      { success: false, op: "secret", errorMessage: "secret" },
    ]

    for (const malformed of malformedResults) {
      let loads = 0
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => malformed as never },
        timer: timerFake().timer,
        fetch: async () => {
          loads += 1
          return new Response("", { status: 200 })
        },
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) continue

      const result = await applicationR.data.projectChange()

      expect(result).toEqual({ success: false, op: "caddyApplication", errorMessage: "project registry read failed" })
      expect(applicationR.data.status()).toEqual({ pending: false, error: "project registry read failed" })
      expect(loads).toBe(0)
    }
  })

  test("rejects malformed project snapshots before queueing or invoking project accessors", async () => {
    const project = structuredClone(caddyConfigGenerateFixtures.proxy)
    let projectAccessorCalled = false
    Object.defineProperty(project, "name", {
      enumerable: true,
      get: () => {
        projectAccessorCalled = true
        throw new Error("project accessor")
      },
    })

    let loads = 0
    let validations = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult({ revision: "revision-invalid", projects: [project] }) },
      timer: timerFake().timer,
      processRunner: async () => {
        validations += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const result = await applicationR.data.projectChange()

    expect(result).toEqual({ success: false, op: "caddyApplication", errorMessage: "project registry read failed" })
    expect(applicationR.data.status()).toEqual({ pending: false, error: "project registry read failed" })
    expect(projectAccessorCalled).toBe(false)
    expect(validations).toBe(0)
    expect(loads).toBe(0)
  })

  test("rejects accessor-backed and proxy-backed project arrays before queueing", async () => {
    const accessorProjects = [structuredClone(caddyConfigGenerateFixtures.proxy)]
    let accessorCalled = false
    Object.defineProperty(accessorProjects, "0", {
      enumerable: true,
      get: () => {
        accessorCalled = true
        throw new Error("projects accessor")
      },
    })

    let proxyCalled = false
    const proxyProjects = new Proxy([structuredClone(caddyConfigGenerateFixtures.proxy)], {
      get: () => {
        proxyCalled = true
        throw new Error("projects proxy")
      },
    })

    for (const projects of [accessorProjects, proxyProjects]) {
      const applicationR = caddyApplicationCreate({
        repository: { read: async () => createResult({ revision: "revision-invalid", projects }) },
        timer: timerFake().timer,
      })
      expect(applicationR.success).toBe(true)
      if (!applicationR.success) continue

      expect(await applicationR.data.projectChange()).toEqual({
        success: false,
        op: "caddyApplication",
        errorMessage: "project registry read failed",
      })
      expect(applicationR.data.status()).toEqual({ pending: false, error: "project registry read failed" })
    }

    expect(accessorCalled).toBe(false)
    expect(proxyCalled).toBe(false)
  })

  test("rejects malformed project entries before queueing", async () => {
    const project = { ...caddyConfigGenerateFixtures.proxy, name: "INVALID" }
    let validations = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult({ revision: "revision-invalid", projects: [project] }) },
      timer: timerFake().timer,
      processRunner: async () => {
        validations += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const result = await applicationR.data.projectChange()

    expect(result).toEqual({ success: false, op: "caddyApplication", errorMessage: "project registry read failed" })
    expect(applicationR.data.status()).toEqual({ pending: false, error: "project registry read failed" })
    expect(validations).toBe(0)
  })

  test("sets lastAttempt when generation fails", async () => {
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-generation-failure")) },
      configOptions: { httpsListener: "invalid" },
      clock: () => 77,
      timer: timerFake().timer,
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const result = await applicationR.data.projectChange()

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("invalid options")
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-generation-failure",
      pendingRevision: "revision-generation-failure",
      pending: true,
      lastAttempt: 77,
    })
    expect(applicationR.data.status().error).toContain("invalid options")
  })

  test("keeps reload required after retry scheduling fails", async () => {
    let current = snapshot("revision-1")
    let validations = 0
    let loads = 0
    let now = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(current) },
      clock: () => {
        now += 1
        return now
      },
      maxRetries: 1,
      timer: {
        wait: async () => {
          throw new Error("timer failed")
        },
        setInterval: () => undefined,
        clearInterval: () => undefined,
      },
      processRunner: async () => {
        validations += 1
        return createResult({ exitCode: validations === 1 ? 1 : 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const first = await applicationR.data.projectChange()

    expect(first).toEqual({
      success: false,
      op: "caddyApplication",
      errorMessage: "Caddy retry scheduling failed",
    })
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-1",
      pendingRevision: "revision-1",
      pending: true,
      lastAttempt: 2,
      error: "Caddy retry scheduling failed",
    })

    current = snapshot("revision-2")
    const second = await applicationR.data.projectChange()

    expect(second).toMatchObject({ success: true, data: { revision: "revision-2", changed: true } })
    expect(validations).toBe(2)
    expect(loads).toBe(1)
    expect(applicationR.data.status()).toMatchObject({
      desiredRevision: "revision-2",
      appliedRevision: "revision-2",
      pending: false,
      error: undefined,
    })
  })

  test("retries an unchanged interval configuration after an application failure", async () => {
    let validates = 0
    let loads = 0
    const fakeTimer = timerFake()
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-1")) },
      maxRetries: 0,
      timer: fakeTimer.timer,
      processRunner: async () => {
        validates += 1
        return createResult({ exitCode: validates === 1 ? 1 : 0, stdout: "", stderr: "" })
      },
      fetch: async () => {
        loads += 1
        return new Response("", { status: 200 })
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    expect((await applicationR.data.start()).success).toBe(false)
    expect(validates).toBe(1)
    expect(loads).toBe(0)

    fakeTimer.intervals[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(validates).toBe(2)
    expect(loads).toBe(1)
    expect(applicationR.data.status()).toMatchObject({
      appliedRevision: "revision-1",
      pending: false,
      error: undefined,
    })
    await applicationR.data.stop()
  })

  test("records interval scheduling failures in status", async () => {
    let failScheduling = true
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-interval")) },
      timer: {
        wait: async () => undefined,
        setInterval: () => {
          if (failScheduling) throw new Error("secret interval failure")
          return 1
        },
        clearInterval: () => undefined,
      },
      processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const failed = await applicationR.data.start()

    expect(failed).toEqual({
      success: false,
      op: "caddyApplication",
      errorMessage: "Caddy interval scheduling failed",
    })
    expect(applicationR.data.status()).toEqual({ pending: false, error: "Caddy interval scheduling failed" })

    failScheduling = false
    expect((await applicationR.data.start()).success).toBe(true)
    expect(applicationR.data.status()).toMatchObject({ pending: false, error: undefined })
    await applicationR.data.stop()
  })

  test("fires startup, manual, project-change, and interval triggers", async () => {
    let reads = 0
    const fakeTimer = timerFake()
    const applicationR = caddyApplicationCreate({
      repository: {
        read: async () => {
          reads += 1
          return createResult(snapshot(`revision-${reads}`))
        },
      },
      timer: fakeTimer.timer,
      processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    await applicationR.data.start()
    await applicationR.data.regenerate()
    await applicationR.data.projectChange()
    fakeTimer.intervals[0]?.()
    await new Promise((resolve) => queueMicrotask(resolve))

    expect(reads).toBe(4)
    applicationR.data.stop()
  })

  test("forwards a validation timeout through application work", async () => {
    const fakeTimer = timeoutTimerFake()
    let processStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      processStarted = resolve
    })
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-timeout")) },
      validationTimeoutMs: 5,
      maxRetries: 0,
      timer: fakeTimer.timer,
      processRunner: async () => {
        processStarted?.()
        return new Promise(() => undefined)
      },
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const resultPromise = applicationR.data.projectChange()
    await started
    fakeTimer.fireTimeout()
    const result = await resultPromise

    expect(result).toEqual({ success: false, op: "caddyApplication", errorMessage: "caddy validate timed out" })
    await applicationR.data.stop()
  })

  test("stops and resolves active validation that ignores cancellation", async () => {
    let processStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      processStarted = resolve
    })
    let signal: AbortSignal | null | undefined
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-active-process")) },
      maxRetries: 0,
      processRunner: async (_command, _args, _input, options) => {
        signal = options?.signal
        processStarted?.()
        return new Promise(() => undefined)
      },
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const active = applicationR.data.projectChange()
    await started
    const stopping = applicationR.data.stop()

    expect(await active).toEqual({
      success: false,
      op: "caddyApplication",
      errorMessage: "Caddy application stopped",
    })
    await stopping
    expect(signal?.aborted).toBe(true)
  })

  test("stops and resolves active admin load that ignores cancellation", async () => {
    let loadStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      loadStarted = resolve
    })
    let signal: AbortSignal | null | undefined
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-active-load")) },
      maxRetries: 0,
      processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
      fetch: async (_input, init) => {
        signal = init.signal
        loadStarted?.()
        return new Promise<Response>(() => undefined)
      },
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const active = applicationR.data.projectChange()
    await started
    const stopping = applicationR.data.stop()

    expect(await active).toEqual({
      success: false,
      op: "caddyApplication",
      errorMessage: "Caddy application stopped",
    })
    await stopping
    expect(signal?.aborted).toBe(true)
  })

  test("stops during a retry wait and rejects queued work deterministically", async () => {
    let waitStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      waitStarted = resolve
    })
    let waitSignal: AbortSignal | undefined
    let reads = 0
    const applicationR = caddyApplicationCreate({
      repository: {
        read: async () => {
          reads += 1
          return createResult(snapshot(`revision-retry-${reads}`))
        },
      },
      maxRetries: 1,
      retryDelayMs: 10,
      timer: {
        wait: async (_delayMs, signal) => {
          waitSignal = signal
          waitStarted?.()
          return new Promise(() => undefined)
        },
        setInterval: () => undefined,
        clearInterval: () => undefined,
      },
      processRunner: async () => createResult({ exitCode: 1, stdout: "", stderr: "" }),
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    const active = applicationR.data.projectChange()
    await started
    const queued = applicationR.data.projectChange()
    const stopping = applicationR.data.stop()
    const results = await Promise.all([active, queued])

    expect(results).toEqual([
      { success: false, op: "caddyApplication", errorMessage: "Caddy application stopped" },
      { success: false, op: "caddyApplication", errorMessage: "Caddy application stopped" },
    ])
    await stopping
    expect(waitSignal?.aborted).toBe(true)
  })

  test("stop is idempotent and prevents post-stop interval application", async () => {
    let intervalCallback: (() => void) | undefined
    let validations = 0
    const applicationR = caddyApplicationCreate({
      repository: { read: async () => createResult(snapshot("revision-stop")) },
      timer: {
        wait: async () => undefined,
        setInterval: (callback) => {
          intervalCallback = callback
          return callback
        },
        clearInterval: () => undefined,
      },
      processRunner: async () => {
        validations += 1
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      fetch: async () => new Response("", { status: 200 }),
    })
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return

    await applicationR.data.start()
    const firstStop = applicationR.data.stop()
    const secondStop = applicationR.data.stop()
    expect(secondStop).toBe(firstStop)
    await firstStop
    intervalCallback?.()

    expect(validations).toBe(1)
    expect(await applicationR.data.regenerate()).toEqual({
      success: false,
      op: "caddyApplication",
      errorMessage: "Caddy application stopped",
    })
    expect(validations).toBe(1)
  })

  test("serializes queue work", async () => {
    const queue = caddyApplicationQueueCreate()
    let active = 0
    let maximum = 0
    const work = async (delay: number) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, delay))
      active -= 1
      return delay
    }

    const results = await Promise.all([queue.enqueue(() => work(5)), queue.enqueue(() => work(0))])

    expect(results).toEqual([5, 0])
    expect(maximum).toBe(1)
  })
})
