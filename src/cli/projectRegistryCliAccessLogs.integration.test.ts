import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createResult, createResultError } from "#result"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { Role } from "../access/Role.js"
import type { ProjectAccessLogSource } from "../access-log/ProjectAccessLogSource.js"
import { projectAccessLogPath } from "../access-log/projectAccessLogPath.js"
import { projectAccessLogSourceFileCreate } from "../access-log/projectAccessLogSourceFileCreate.js"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { Project } from "../project/Project.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRegistryDaemonFileStat } from "../runtime/ProjectRegistryDaemonFileStat.js"
import type { ProjectRegistryDaemonFilesystem } from "../runtime/ProjectRegistryDaemonFilesystem.js"
import type { ProjectRegistryDaemonMappedUser } from "../runtime/ProjectRegistryDaemonMappedUser.js"
import type { ProjectRegistryDaemonServerFactory } from "../runtime/ProjectRegistryDaemonServerFactory.js"
import type { ProjectRegistryDaemonSignals } from "../runtime/ProjectRegistryDaemonSignals.js"
import { projectRegistryDaemonCreate } from "../runtime/projectRegistryDaemonCreate.js"
import { projectRegistryCliRun } from "./projectRegistryCliRun.js"

const revision = "a".repeat(40)
const socketDirectory = "/run/project-registry-access-logs-integration"

type RequestObservation = {
  path: string
  socket: string
  status: number
  body: unknown
}

type CliOutput = {
  exitCode: number
  stdout: string
  stderr: string
}

type AccessLogHarness = {
  activePath: string
  root: string
  requests: RequestObservation[]
  run(args: readonly string[], environment?: Readonly<Record<string, string | undefined>>): Promise<CliOutput>
  close(): Promise<void>
}

function projectCreate(owner: string, name: string, disabled = false): Project {
  return {
    schemaVersion: 1,
    owner,
    name,
    type: "customer",
    order: 0,
    services: [],
    caddy: {
      port: 4321,
      domains: [`${owner}.example`],
      path: "/srv/project",
      access: "external",
      kind: "proxy",
      docs: false,
      browse: false,
      headerUp: {},
      disabled,
      denyDotfiles: false,
      spa: false,
    },
  }
}

function repositoryCreate(): ProjectRepository {
  const projects = [
    projectCreate("leo", "site"),
    projectCreate("david", "site"),
    projectCreate("leo", "unavailable", true),
  ]
  const repository: ProjectRepository = {
    read: async () => createResult({ projects, revision }),
    get: async (key) => {
      const project = projects.find((entry) => entry.owner === key.owner && entry.name === key.name)
      return project === undefined
        ? createResultError("projectRepositoryGet", "project not found")
        : createResult({ project, revision })
    },
    create: async () => createResultError("projectRepositoryCreate", "not implemented"),
    edit: async () => createResultError("projectRepositoryEdit", "not implemented"),
    delete: async () => createResultError("projectRepositoryDelete", "not implemented"),
    history: async () => createResult([]),
    ownerHistory: async () => createResult([]),
    readiness: async () => createResult({ ready: true, clean: true, revision }),
    recover: async () => createResult({ ready: true, clean: true, revision }),
  }
  return repository
}

function caddyApplicationCreate(): CaddyApplication {
  const result = { revision, changed: false, applied: true, attempts: 1 }
  return {
    start: async () => createResult(result),
    startup: async () => createResult(result),
    regenerate: async () => createResult(result),
    projectChange: async () => createResult(result),
    status: () => ({ desiredRevision: revision, appliedRevision: revision, pending: false }),
    stop: async () => undefined,
  }
}

function projectLogRecord(timestamp: number): string {
  return JSON.stringify({
    ts: timestamp,
    request: {
      method: "GET",
      host: "leo.example",
      uri: `/path?secret=${timestamp}`,
      client_ip: `192.0.2.${timestamp + 1}`,
    },
    status: 200,
    duration: 0.01,
    size: timestamp,
  })
}

function filesystemCreate(): {
  filesystem: ProjectRegistryDaemonFilesystem
  entries: Map<string, ProjectRegistryDaemonFileStat>
} {
  const entries = new Map<string, ProjectRegistryDaemonFileStat>([
    ["/", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
    ["/run", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
  ])
  const filesystem: ProjectRegistryDaemonFilesystem = {
    lstat: async (path) => entries.get(path),
    realpath: async (path) => path,
    mkdir: async (path, mode) => {
      entries.set(path, { type: "directory", mode, uid: 0, gid: 0 })
    },
    readdir: async (path) => {
      const prefix = path === "/" ? "/" : `${path}/`
      return [...entries.keys()]
        .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"))
        .map((entry) => entry.slice(prefix.length))
    },
    chmod: async (path, mode) => {
      const entry = entries.get(path)
      if (entry === undefined) throw new Error(`missing path: ${path}`)
      entry.mode = mode
    },
    chown: async (path, uid, gid) => {
      const entry = entries.get(path)
      if (entry === undefined) throw new Error(`missing path: ${path}`)
      entry.uid = uid
      entry.gid = gid
    },
    unlink: async (path) => {
      entries.delete(path)
    },
  }
  return { filesystem, entries }
}

function serverFactoryCreate(entries: Map<string, ProjectRegistryDaemonFileStat>): {
  factory: ProjectRegistryDaemonServerFactory
  unixFetches: Map<string, (request: Request) => Response | Promise<Response>>
} {
  const unixFetches = new Map<string, (request: Request) => Response | Promise<Response>>()
  const factory: ProjectRegistryDaemonServerFactory = (options) => {
    if (options.unix !== undefined) {
      entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
      unixFetches.set(options.unix, options.fetch)
    }
    return { stop: () => undefined }
  }
  return { factory, unixFetches }
}

function signalsCreate(): ProjectRegistryDaemonSignals {
  return { on: () => () => undefined }
}

function accessCreate(username: string, role: Role): ProjectAccess {
  return {
    actorResolve: async () => createResult({ subject: `${username}-subject`, username, role }),
    ownerRoleResolve: async (owner) => createResult(owner === "leo" || owner === "david" ? "own" : undefined),
  }
}

async function accessLogHarnessCreate(): Promise<AccessLogHarness> {
  const root = await mkdtemp(join(tmpdir(), "project-registry-cli-access-logs-"))
  const activePathR = projectAccessLogPath(root, { owner: "leo", name: "site" })
  if (!activePathR.success) throw new Error(activePathR.errorMessage)
  await mkdir(dirname(activePathR.data), { recursive: true })
  await writeFile(activePathR.data, `${projectLogRecord(1)}\n${projectLogRecord(2)}\n`)

  const sourceR = projectAccessLogSourceFileCreate({ root, cursorSecret: "cli-integration-secret" })
  if (!sourceR.success) throw new Error(sourceR.errorMessage)

  const fakeFilesystem = filesystemCreate()
  const fakeServers = serverFactoryCreate(fakeFilesystem.entries)
  const mappings: readonly ProjectRegistryDaemonMappedUser[] = [
    { username: "leo", uid: 1001, gid: 1001 },
    { username: "admin", uid: 1002, gid: 1002 },
  ]
  const daemonR = projectRegistryDaemonCreate({
    config: {
      repositoryPath: "/tmp/project-registry-cli-access-logs",
      mappedUsers: ["leo", "admin"],
      socketDirectory,
      webListener: { hostname: "127.0.0.1", port: 18080 },
      userRefreshIntervalMs: 60_000,
      shutdownTimeoutMs: 1_000,
    },
    repository: repositoryCreate(),
    caddyApplication: caddyApplicationCreate(),
    projectAccessLogSource: sourceR.data as ProjectAccessLogSource,
    socketAccessResolve: async (username) => {
      if (username === "leo") return createResult(accessCreate(username, "own"))
      if (username === "admin") return createResult(accessCreate(username, "admin"))
      return createResultError("projectRegistryDaemonSocketAccessResolve", "socket actor role is unavailable")
    },
    mappedUsersResolve: async () => createResult(mappings),
    filesystem: fakeFilesystem.filesystem,
    serverFactory: fakeServers.factory,
    signals: signalsCreate(),
    timer: {
      wait: async () => undefined,
      setInterval: () => "integration-timer",
      clearInterval: () => undefined,
    },
    requireRoot: false,
  })
  if (!daemonR.success) {
    await rm(root, { recursive: true, force: true })
    throw new Error(daemonR.errorMessage)
  }
  const startR = await daemonR.data.start()
  if (!startR.success) {
    await rm(root, { recursive: true, force: true })
    throw new Error(startR.errorMessage)
  }

  const requests: RequestObservation[] = []
  const requestFetch = async (
    input: string | URL | Request,
    init?: RequestInit & { unix?: string },
  ): Promise<Response> => {
    const socket = init?.unix
    if (socket === undefined) throw new Error("CLI request did not select a Unix socket")
    const fetch = fakeServers.unixFetches.get(socket)
    if (fetch === undefined) throw new Error(`No Unix listener for ${socket}`)
    const { unix: _unix, ...requestInit } = init ?? {}
    const request = new Request(input, requestInit)
    const url = new URL(request.url)
    const response = await fetch(request)
    let body: unknown
    try {
      body = await response.clone().json()
    } catch {
      body = undefined
    }
    requests.push({ path: `${url.pathname}${url.search}`, socket, status: response.status, body })
    return response
  }

  return {
    activePath: activePathR.data,
    root,
    requests,
    run: async (args, environment = { USER: "spoofed-user" }) => {
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await projectRegistryCliRun(args, {
        environment,
        requestFetch,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      })
      return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") }
    },
    close: async () => {
      await daemonR.data.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function jsonParse(value: string): Record<string, any> {
  return JSON.parse(value) as Record<string, any>
}

describe("projectRegistryCli access-log Unix integration", () => {
  test("uses the socket owner, authorizes explicit owners, and round-trips cursors", async () => {
    const harness = await accessLogHarnessCreate()
    try {
      const leoSocket = `${socketDirectory}/leo.sock`
      const adminSocket = `${socketDirectory}/admin.sock`

      const inferred = await harness.run(
        ["project", "access-logs", "site", "--limit", "1", "--socket", leoSocket, "--json"],
        { USER: "admin" },
      )
      expect(inferred.exitCode).toBe(0)
      const inferredEnvelope = jsonParse(inferred.stdout)
      expect(inferredEnvelope.data.records.map((record: { timestamp: number }) => record.timestamp)).toEqual([2])
      expect(inferredEnvelope.data.next).toEqual(expect.any(String))
      expect(harness.requests[0]).toMatchObject({
        path: "/api/v1/projects/site/access-logs?limit=1",
        socket: leoSocket,
        status: 200,
      })

      const explicitAuthorized = await harness.run(
        ["project", "access-logs", "site", "--owner", "leo", "--limit", "1", "--socket", adminSocket, "--json"],
        { USER: "leo" },
      )
      expect(explicitAuthorized.exitCode).toBe(0)
      expect(jsonParse(explicitAuthorized.stdout).data.records[0].timestamp).toBe(2)
      expect(harness.requests[1]).toMatchObject({
        path: "/api/v1/users/leo/projects/site/access-logs?limit=1",
        socket: adminSocket,
        status: 200,
      })

      const explicitUnauthorized = await harness.run(
        ["project", "access-logs", "site", "--owner", "david", "--socket", leoSocket, "--json"],
        { USER: "admin" },
      )
      expect(explicitUnauthorized.exitCode).toBe(1)
      expect(jsonParse(explicitUnauthorized.stderr)).toMatchObject({
        success: false,
        error: { code: "access-log.not-found", status: 404 },
      })
      expect(harness.requests[2]).toMatchObject({
        path: "/api/v1/users/david/projects/site/access-logs",
        socket: leoSocket,
        status: 404,
        body: { success: false, error: { code: "access-log.not-found", status: 404 } },
      })

      const cursor = inferredEnvelope.data.next as string
      const continued = await harness.run(
        ["project", "access-logs", "site", "--limit", "1", "--before", cursor, "--socket", leoSocket, "--json"],
        { USER: "admin" },
      )
      expect(continued.exitCode).toBe(0)
      expect(jsonParse(continued.stdout).data.records.map((record: { timestamp: number }) => record.timestamp)).toEqual(
        [1],
      )
      expect(harness.requests[3]?.path).toBe(
        `/api/v1/projects/site/access-logs?limit=1&before=${encodeURIComponent(cursor)}`,
      )
      expect(harness.requests[3]?.socket).toBe(leoSocket)
    } finally {
      await harness.close()
    }
  })

  test("maps real source expiry and unavailable storage to CLI status envelopes", async () => {
    const harness = await accessLogHarnessCreate()
    try {
      const leoSocket = `${socketDirectory}/leo.sock`
      const first = await harness.run(
        ["project", "access-logs", "site", "--limit", "1", "--socket", leoSocket, "--json"],
        { USER: "spoofed-user" },
      )
      const cursor = jsonParse(first.stdout).data.next as string

      await writeFile(harness.activePath, `${projectLogRecord(9)}\n${projectLogRecord(8)}\n`)
      const expired = await harness.run(
        ["project", "access-logs", "site", "--limit", "1", "--before", cursor, "--socket", leoSocket, "--json"],
        { USER: "spoofed-user" },
      )
      expect(expired.exitCode).toBe(1)
      expect(jsonParse(expired.stderr)).toMatchObject({
        success: false,
        error: { code: "access-log.cursor-expired", status: 410 },
      })
      expect(harness.requests[1]).toMatchObject({
        status: 410,
        body: {
          success: false,
          error: { code: "access-log.cursor-expired", status: 410, retryable: false, details: {} },
        },
      })

      await rm(harness.root, { recursive: true, force: true })
      await writeFile(harness.root, "not a directory")
      const unavailable = await harness.run(["project", "access-logs", "site", "--socket", leoSocket, "--json"], {
        USER: "spoofed-user",
      })
      expect(unavailable.exitCode).toBe(1)
      expect(jsonParse(unavailable.stderr)).toMatchObject({
        success: false,
        error: { code: "access-log.non-regular-file", status: 503 },
      })
      expect(harness.requests[2]).toMatchObject({
        status: 503,
        body: {
          success: false,
          error: {
            code: "access-log.non-regular-file",
            status: 503,
            retryable: true,
            details: {},
          },
        },
      })
    } finally {
      await harness.close()
    }
  })
})
