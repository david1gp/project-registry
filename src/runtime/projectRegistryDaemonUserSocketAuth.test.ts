import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"
import { createResult } from "#result"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import { projectRepositoryOpen } from "../project-store/projectRepositoryOpen.js"
import { projectRegistryCliRun } from "../cli/projectRegistryCliRun.js"
import { projectRegistryDaemonOpen } from "./projectRegistryDaemonOpen.js"
import { projectRegistryDaemonPosixDefault } from "./projectRegistryDaemonPosixDefault.js"
import { projectRegistryDaemonServerDefault } from "./projectRegistryDaemonServerDefault.js"

async function harnessCreate() {
  // Socket ancestors must not be group/world writable; /tmp is unsuitable.
  const directory = await mkdtemp(join(process.cwd(), ".registry-socket-auth-test-"))
  const owner = userInfo().username
  const repositoryPath = join(directory, "data")
  const git = Bun.spawnSync(["git", "init", "--initial-branch=main", repositoryPath])
  expect(git.exitCode).toBe(0)
  const commit = Bun.spawnSync([
    "git",
    "-C",
    repositoryPath,
    "-c",
    "user.name=Registry test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "test fixture",
  ])
  expect(commit.exitCode).toBe(0)
  const repositoryR = await projectRepositoryOpen({ dir: repositoryPath, autoPush: false })
  expect(repositoryR.success).toBe(true)
  if (!repositoryR.success) throw new Error(repositoryR.errorMessage)
  const applied = { revision: "test", changed: false, applied: true, attempts: 1 }
  const caddyApplication: CaddyApplication = {
    start: async () => createResult(applied),
    startup: async () => createResult(applied),
    regenerate: async () => createResult(applied),
    projectChange: async () => createResult(applied),
    status: () => ({ pending: false }),
    stop: async () => undefined,
  }
  const serverDefault = projectRegistryDaemonServerDefault()
  const posixDefault = projectRegistryDaemonPosixDefault()
  let httpUrl = ""
  let wrongUid = false
  const socketDirectory = join(directory, "sockets")
  const socket = join(socketDirectory, `${owner}.sock`)
  const daemonR = await projectRegistryDaemonOpen({
    config: {
      mode: "user",
      repositoryPath,
      mappedUsers: [owner],
      socketDirectory,
      serverIp: "127.0.0.1",
      cloudflareDns: { enabled: false },
      webListener: { hostname: "127.0.0.1", port: 8080 },
    },
    repository: repositoryR.data,
    caddyApplication,
    posix: {
      ...posixDefault,
      userResolve: async (username) => {
        const result = await posixDefault.userResolve(username)
        return result.success && wrongUid ? createResult({ ...result.data, uid: result.data.uid + 1 }) : result
      },
    },
    serverFactory: async (options) => {
      const server = await serverDefault(options.unix === undefined ? { ...options, port: 0 } : options)
      if (options.unix === undefined) httpUrl = `http://127.0.0.1:${(server as unknown as { port: number }).port}`
      return server
    },
  })
  expect(daemonR.success).toBe(true)
  if (!daemonR.success) throw new Error(daemonR.errorMessage)
  expect((await daemonR.data.start()).success).toBe(true)
  return {
    owner,
    socket,
    socketDirectory,
    repository: repositoryR.data,
    wrongUidSet: () => {
      wrongUid = true
    },
    request: (path: string, method = "GET", body?: unknown, http = false) =>
      fetch(`${http ? httpUrl : "http://localhost"}${path}`, {
        method,
        ...(http ? {} : { unix: socket }),
        headers: { "content-type": "application/json", USER: "root", "x-project-registry-user": "root" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: async () => {
      await daemonR.data.shutdown()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("default user-mode private socket authorizes own list/create/edit/delete without Zitadel and serves the CLI", async () => {
  const harness = await harnessCreate()
  try {
    const path = `/api/v1/users/${harness.owner}/projects`
    const listed = await harness.request(path)
    expect(listed.status).toBe(200)
    const initial = (await listed.json()) as { data: { revision: string } }
    const created = await harness.request(path, "POST", {
      expectedRevision: initial.data.revision,
      name: "socket-auth",
      caddy: { domains: ["socket-auth.example"] },
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ success: true, data: { action: "create" } })
    const snapshot = await harness.repository.read()
    expect(snapshot.success).toBe(true)
    if (!snapshot.success) return
    const edited = await harness.request(`${path}/socket-auth`, "PATCH", {
      expectedRevision: snapshot.data.revision,
      description: "same-owner edit",
    })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({ success: true, data: { action: "edit" } })
    const stdout: string[] = []
    expect(
      await projectRegistryCliRun(["--socket", harness.socket, "--json", "project", "list"], {
        environment: { USER: harness.owner },
        stdout: (value) => stdout.push(value),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join(""))).toMatchObject({ success: true })
    const afterEdit = await harness.repository.read()
    if (!afterEdit.success) throw new Error(afterEdit.errorMessage)
    const deleted = await harness.request(`${path}/socket-auth`, "DELETE", {
      expectedRevision: afterEdit.data.revision,
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ success: true, data: { action: "delete" } })
  } finally {
    await harness.close()
  }
})

test("user socket rejects another owner and HTTP headers cannot authenticate any owner", async () => {
  const harness = await harnessCreate()
  try {
    const ownPath = `/api/v1/users/${harness.owner}/projects`
    const otherPath = `/api/v1/users/${harness.owner === "root" ? "nobody" : "root"}/projects`
    for (const [path, method] of [
      [otherPath, "GET"],
      [otherPath, "POST"],
      [`${otherPath}/site`, "PATCH"],
      [`${otherPath}/site`, "DELETE"],
    ]) {
      const response = await harness.request(path!, method!, method === "GET" ? undefined : {})
      expect(response.status).toBe(403)
    }
    for (const path of [ownPath, otherPath]) {
      const response = await harness.request(path, "GET", undefined, true)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ success: false, error: { code: "api.unauthenticated" } })
    }
    const errors: string[] = []
    expect(
      await projectRegistryCliRun(["--socket", harness.socket, "--json", "project", "list"], {
        environment: { USER: harness.owner === "root" ? "nobody" : "root" },
        stderr: (value) => errors.push(value),
      }),
    ).toBe(1)
    expect(JSON.parse(errors.join(""))).toMatchObject({ success: false, error: { code: "projects.forbidden" } })
  } finally {
    await harness.close()
  }
})

test("user-mode authorization fails closed if socket permissions or resolved daemon UID change", async () => {
  const harness = await harnessCreate()
  try {
    const path = `/api/v1/users/${harness.owner}/projects`
    await chmod(harness.socket, 0o666)
    expect((await harness.request(path)).status).toBe(401)
    await chmod(harness.socket, 0o600)
    await chmod(harness.socketDirectory, 0o755)
    expect((await harness.request(path)).status).toBe(401)
    await chmod(harness.socketDirectory, 0o700)
    harness.wrongUidSet()
    expect((await harness.request(path)).status).toBe(401)
  } finally {
    await harness.close()
  }
})
