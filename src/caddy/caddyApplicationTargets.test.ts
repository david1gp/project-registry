import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createResult, createResultError } from "#result"
import { projectAccessLogCaddyRetention } from "../access-log/projectAccessLogCaddyRetention.js"
import { projectAccessLogId } from "../access-log/projectAccessLogId.js"
import { projectAccessLogRetentionReconcile } from "../access-log/projectAccessLogRetentionReconcile.js"
import type { CaddyApplicationOptions } from "./CaddyApplicationOptions.js"
import { caddyApplicationCreate } from "./caddyApplicationCreate.js"

const mixedProject = {
  schemaVersion: 2,
  owner: "leo",
  name: "pilot",
  services: [
    { id: "public", units: ["public.service"], caddy: { port: 4108, domains: ["public.example"] } },
    {
      id: "private",
      units: ["private.service"],
      caddy: { port: 4109, domains: ["private.example", "alias.example"], networkVisibility: "private" },
    },
  ],
}

const targets = {
  public: {
    adminUrl: "http://127.0.0.1:2019",
    caddyBin: "public-caddy",
    configOptions: { httpsListeners: ["192.0.2.1:443"] },
  },
  private: {
    adminUrl: "http://127.0.0.1:2020",
    caddyBin: "private-caddy",
    configOptions: { httpsListeners: ["100.122.200.114:443"] },
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function options(overrides: Partial<CaddyApplicationOptions> = {}): CaddyApplicationOptions {
  return {
    repository: {
      read: async () => createResult({ revision: "r1", projects: [structuredClone(mixedProject)] }) as never,
    },
    targets,
    maxRetries: 0,
    timer: { wait: async () => undefined, setInterval: () => 1, clearInterval: () => undefined },
    processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
    fetch: async () => new Response("", { status: 200 }),
    ...overrides,
  }
}

describe("Caddy application targets", () => {
  test("validates every target before public-first loads, retaining each baseline and target options", async () => {
    const events: string[] = []
    const loads: Array<{ url: string; body: string }> = []
    const applicationR = caddyApplicationCreate(
      options({
        targets: {
          public: {
            ...targets.public,
            configReconcile: async (config) => createResult({ ...config, admin: { listen: "127.0.0.1:2019" } }),
          },
          private: {
            ...targets.private,
            configReconcile: async (config) => createResult({ ...config, admin: { listen: "127.0.0.1:2020" } }),
          },
        },
        processRunner: async (command) => {
          events.push(command)
          return createResult({ exitCode: 0, stdout: "", stderr: "" })
        },
        fetch: async (url, init) => {
          events.push(url)
          loads.push({ url, body: String(init.body) })
          return new Response("", { status: 200 })
        },
      }),
    )
    expect(applicationR.success).toBe(true)
    if (!applicationR.success) return
    expect(await applicationR.data.projectChange()).toEqual({
      success: true,
      data: { revision: "r1", changed: true, applied: true, attempts: 1 },
    })
    expect(events).toEqual([
      "public-caddy",
      "private-caddy",
      `${targets.public.adminUrl}/load`,
      `${targets.private.adminUrl}/load`,
    ])
    expect(loads[0]!.body).toContain("public.example")
    expect(loads[0]!.body).not.toContain("private.example")
    expect(loads[0]!.body).toContain("192.0.2.1:443")
    expect(loads[1]!.body).toContain("private.example")
    expect(loads[1]!.body).toContain("alias.example")
    expect(loads[1]!.body).not.toContain("public.example")
    expect(loads[1]!.body).toContain("100.122.200.114:443")
    expect(JSON.parse(loads[1]!.body).admin).toEqual({ listen: "127.0.0.1:2020" })
    expect(await applicationR.data.projectChange()).toEqual({
      success: true,
      data: { revision: "r1", changed: false, applied: true, attempts: 0 },
    })
    expect(events).toHaveLength(4)
    expect(await applicationR.data.stop()).toEqual(createResult(undefined))
  })

  test("rejects private routes with no private target rather than publishing them publicly", async () => {
    let io = 0
    const applicationR = caddyApplicationCreate(
      options({
        targets: undefined,
        processRunner: async () => {
          io += 1
          return createResult({ exitCode: 0, stdout: "", stderr: "" })
        },
        fetch: async () => {
          io += 1
          return new Response("")
        },
      }),
    )
    if (!applicationR.success) throw new Error("create failed")
    const result = await applicationR.data.projectChange()
    expect(result.success).toBe(false)
    if (!result.success) expect(result.errorMessage).toContain("private target")
    expect(io).toBe(0)
    expect(applicationR.data.status()).toMatchObject({ pending: true, desiredRevision: "r1" })
    await applicationR.data.stop()
  })

  test("rejects normalized cross-visibility alias claims without Cloudflare integration", async () => {
    let io = 0
    const project = structuredClone(mixedProject)
    project.services[1]!.caddy.domains = ["PUBLIC.EXAMPLE."]
    const applicationR = caddyApplicationCreate(
      options({
        repository: { read: async () => createResult({ revision: "conflict", projects: [project] }) as never },
        processRunner: async () => {
          io += 1
          return createResult({ exitCode: 0, stdout: "", stderr: "" })
        },
        fetch: async () => {
          io += 1
          return new Response("")
        },
      }),
    )
    if (!applicationR.success) throw new Error("create failed")
    const result = await applicationR.data.projectChange()
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.errorMessage).toContain("Conflicting public/private Caddy hostname claim: public.example")
    expect(io).toBe(0)
    await applicationR.data.stop()
  })

  test("does not load public when a private candidate fails generation, reconciliation, or validation", async () => {
    for (const failure of ["generation", "reconciliation", "validation"]) {
      let loads = 0
      const applicationR = caddyApplicationCreate(
        options({
          targets: {
            public: targets.public,
            private: {
              ...targets.private,
              ...(failure === "generation" ? { configOptions: { httpsListeners: ["invalid"] } } : {}),
              ...(failure === "reconciliation"
                ? { configReconcile: async () => createResultError("baseline", "baseline unavailable") }
                : {}),
            },
          },
          processRunner: async (command) =>
            createResult({
              exitCode: failure === "validation" && command === "private-caddy" ? 1 : 0,
              stdout: "",
              stderr: "",
            }),
          fetch: async () => {
            loads += 1
            return new Response("")
          },
        }),
      )
      if (!applicationR.success) throw new Error("create failed")
      expect((await applicationR.data.projectChange()).success).toBe(false)
      expect(loads).toBe(0)
      expect(applicationR.data.status().appliedRevision).toBeUndefined()
      await applicationR.data.stop()
    }
  })

  test("rejects a public baseline that would retain a private hostname", async () => {
    let loads = 0
    const applicationR = caddyApplicationCreate(
      options({
        targets: {
          public: {
            ...targets.public,
            configReconcile: async (config) => {
              config.apps.http.servers.srv0.routes.push({ match: [{ host: ["PRIVATE.EXAMPLE."] }] })
              return createResult(config)
            },
          },
          private: targets.private,
        },
        fetch: async () => {
          loads += 1
          return new Response("")
        },
      }),
    )
    if (!applicationR.success) throw new Error("create failed")
    const result = await applicationR.data.projectChange()
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.errorMessage).toContain("Conflicting public/private Caddy hostname claim: private.example")
    expect(loads).toBe(0)
    await applicationR.data.stop()
  })

  test("one queue serializes both targets before applying a newer snapshot", async () => {
    const firstPrivate = deferred<Response>()
    const privateStarted = deferred<void>()
    const secondRead = deferred<void>()
    const calls: Array<{ url: string; body: string }> = []
    let revision = "r1"
    const applicationR = caddyApplicationCreate(
      options({
        repository: {
          read: async () => {
            const project = structuredClone(mixedProject)
            if (revision === "r2") {
              project.services[0]!.caddy.domains = ["new-public.example"]
              project.services[1]!.caddy.domains = ["new-private.example"]
              secondRead.resolve()
            }
            return createResult({ revision, projects: [project] }) as never
          },
        },
        fetch: async (url, init) => {
          calls.push({ url, body: String(init.body) })
          if (calls.length === 2) {
            privateStarted.resolve()
            return firstPrivate.promise
          }
          return new Response("")
        },
      }),
    )
    if (!applicationR.success) throw new Error("create failed")
    const first = applicationR.data.projectChange()
    await privateStarted.promise
    revision = "r2"
    const second = applicationR.data.projectChange()
    await secondRead.promise
    expect(calls).toHaveLength(2)
    firstPrivate.resolve(new Response(""))
    expect((await first).success).toBe(true)
    expect((await second).success).toBe(true)
    expect(calls.map((call) => call.url)).toEqual([
      `${targets.public.adminUrl}/load`,
      `${targets.private.adminUrl}/load`,
      `${targets.public.adminUrl}/load`,
      `${targets.private.adminUrl}/load`,
    ])
    expect(calls[2]!.body).toContain("new-public.example")
    expect(calls[3]!.body).toContain("new-private.example")
    expect(applicationR.data.status()).toMatchObject({ appliedRevision: "r2", pending: false })
    await applicationR.data.stop()
  })

  test("retries only private after a partial load, aggregates acknowledgement, and preserves failed drain evidence", async () => {
    const calls: string[] = []
    const privateRetry = deferred<Response>()
    const retryStarted = deferred<void>()
    const applicationR = caddyApplicationCreate(
      options({
        maxRetries: 1,
        fetch: async (url) => {
          calls.push(url)
          if (calls.length === 2) return new Response("", { status: 500 })
          if (calls.length === 3) {
            retryStarted.resolve()
            return privateRetry.promise
          }
          return new Response("")
        },
      }),
    )
    if (!applicationR.success) throw new Error("create failed")
    const work = applicationR.data.regenerate()
    await retryStarted.promise
    expect(applicationR.data.status()).toMatchObject({ pending: true, desiredRevision: "r1" })
    expect(applicationR.data.status().appliedRevision).toBeUndefined()
    expect(applicationR.data.status().lastSuccess).toBeUndefined()
    privateRetry.resolve(new Response(""))
    expect(await work).toEqual({ success: true, data: { revision: "r1", changed: true, applied: true, attempts: 2 } })
    expect(calls).toEqual([
      `${targets.public.adminUrl}/load`,
      `${targets.private.adminUrl}/load`,
      `${targets.private.adminUrl}/load`,
    ])
    expect(applicationR.data.status()).toMatchObject({ appliedRevision: "r1", pending: false })
    expect(await applicationR.data.stop()).toEqual(
      createResultError("caddyApplicationStop", "caddy admin load failed (status 500)"),
    )
  })

  test("retains public acknowledgement across triggers after private retries are exhausted", async () => {
    const calls: string[] = []
    let privateFails = true
    const applicationR = caddyApplicationCreate(
      options({
        fetch: async (url) => {
          calls.push(url)
          return new Response("", { status: url.includes(":2020") && privateFails ? 500 : 200 })
        },
      }),
    )
    if (!applicationR.success) throw new Error("create failed")
    expect((await applicationR.data.projectChange()).success).toBe(false)
    privateFails = false
    expect((await applicationR.data.projectChange()).success).toBe(true)
    expect(calls).toEqual([
      `${targets.public.adminUrl}/load`,
      `${targets.private.adminUrl}/load`,
      `${targets.private.adminUrl}/load`,
    ])
    await applicationR.data.stop()
  })

  test("stop drains an in-flight private load and discards queued publications", async () => {
    const privateLoad = deferred<Response>()
    const privateStarted = deferred<void>()
    const calls: string[] = []
    const applicationR = caddyApplicationCreate(
      options({
        fetch: async (url) => {
          calls.push(url)
          if (url.includes(":2020")) {
            privateStarted.resolve()
            return privateLoad.promise
          }
          return new Response("")
        },
      }),
    )
    if (!applicationR.success) throw new Error("create failed")
    const work = applicationR.data.projectChange()
    await privateStarted.promise
    const queued = applicationR.data.regenerate()
    const stop = applicationR.data.stop()
    let stopped = false
    void stop.then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    privateLoad.resolve(new Response(""))
    expect(await stop).toEqual(createResult(undefined))
    expect((await work).success).toBe(false)
    expect((await queued).success).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test("rejects ambiguous explicit options and duplicate admin endpoints", () => {
    expect(caddyApplicationCreate(options({ adminUrl: targets.public.adminUrl })).success).toBe(false)
    expect(
      caddyApplicationCreate(
        options({
          targets: { public: targets.public, private: { ...targets.private, adminUrl: `${targets.public.adminUrl}/` } },
        }),
      ).success,
    ).toBe(false)
  })

  test("reconciles each target's log root using only its own active projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "caddy-application-target-logs-"))
    const publicRoot = join(root, "public")
    const privateRoot = join(root, "private")
    const projects = mixedProject.services.map((service) => ({
      ...mixedProject,
      name: `${service.id}-project`,
      services: [service],
    }))
    const publicId = projectAccessLogId(projects[0]!)
    const privateId = projectAccessLogId(projects[1]!)
    try {
      for (const logRoot of [publicRoot, privateRoot]) {
        for (const id of [publicId, privateId]) {
          const directory = join(logRoot, "projects", id)
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, "access.jsonl"), "")
        }
        await projectAccessLogRetentionReconcile({ root: logRoot, activeProjectIds: [], now: 0 })
      }
      const applicationR = caddyApplicationCreate(
        options({
          repository: { read: async () => createResult({ revision: "logs", projects }) as never },
          clock: () => projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000 + 1,
          targets: {
            public: {
              ...targets.public,
              configOptions: { ...targets.public.configOptions, caddyAccessLogRoot: publicRoot },
            },
            private: {
              ...targets.private,
              configOptions: { ...targets.private.configOptions, caddyAccessLogRoot: privateRoot },
            },
          },
        }),
      )
      if (!applicationR.success) throw new Error("create failed")
      expect((await applicationR.data.projectChange()).success).toBe(true)
      expect((await lstat(join(publicRoot, "projects", publicId))).isDirectory()).toBe(true)
      expect((await lstat(join(privateRoot, "projects", privateId))).isDirectory()).toBe(true)
      await expect(lstat(join(publicRoot, "projects", privateId))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(lstat(join(privateRoot, "projects", publicId))).rejects.toMatchObject({ code: "ENOENT" })
      await applicationR.data.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
