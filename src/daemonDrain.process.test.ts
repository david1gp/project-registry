import { expect, test } from "bun:test"
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"

type ChildProcess = ReturnType<typeof Bun.spawn>

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: () => string): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(message())
}

async function outputRead(stream: ReadableStream<Uint8Array>, append: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }))
  append(decoder.decode())
}

async function responseRead(response: Response): Promise<string> {
  return response.text()
}

async function fixtureCreate() {
  // /tmp has a writable ancestor, which real user-mode sockets intentionally reject.
  // A checkout may also be group-writable or too deep for a Unix-socket path.
  // Canonicalize the runtime/home root and keep the private temporary name short.
  const runtimeRoot = await realpath(process.env.XDG_RUNTIME_DIR ?? homedir())
  let directory: string | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  let child: ChildProcess | undefined
  let outputComplete: Promise<unknown> | undefined
  try {
    directory = await mkdtemp(join(runtimeRoot, ".pr-drain-"))
    const username = userInfo().username
    const repositoryPath = join(directory, "repository")
    const socketDirectory = join(directory, "sockets")
    const socketPath = join(socketDirectory, `${username}.sock`)
    const fakeCaddy = join(directory, "fake-caddy")
    const git = Bun.spawnSync(["git", "init", "--initial-branch=main", repositoryPath])
    expect(git.exitCode).toBe(0)
    const commit = Bun.spawnSync([
      "git",
      "-C",
      repositoryPath,
      "-c",
      "user.name=Registry process test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ])
    expect(commit.exitCode).toBe(0)
    await Bun.write(fakeCaddy, "#!/bin/sh\ncat >/dev/null\nexit 0\n")
    await chmod(fakeCaddy, 0o700)

    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const webPort = reservation.port
    reservation.stop(true)
    let loadSeenResolve: (() => void) | undefined
    const loadSeen = new Promise<void>((resolve) => (loadSeenResolve = resolve))
    let loadAckResolve: (() => void) | undefined
    const loadAck = new Promise<void>((resolve) => (loadAckResolve = resolve))
    let loadAcknowledged = false
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/load") return new Response("not found", { status: 404 })
        await request.arrayBuffer()
        loadSeenResolve?.()
        await loadAck
        loadAcknowledged = true
        return new Response("", { status: 200 })
      },
    })

    child = Bun.spawn(["bun", "src/daemon.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        USER: username,
        XDG_RUNTIME_DIR: directory,
        PROJECT_REGISTRY_MODE: "user",
        PROJECT_REGISTRY_REPOSITORY_PATH: repositoryPath,
        PROJECT_REGISTRY_USERS: username,
        PROJECT_REGISTRY_SOCKET_DIRECTORY: socketDirectory,
        PROJECT_REGISTRY_WEB_PORT: String(webPort),
        PROJECT_REGISTRY_CADDY_BINARY: fakeCaddy,
        PROJECT_REGISTRY_CADDY_ADMIN_URL: `http://127.0.0.1:${server.port}`,
        PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG: "true",
        PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED: "false",
        PROJECT_REGISTRY_SERVER_IP_DISCOVERY_TIMEOUT_MS: "1000",
        PROJECT_REGISTRY_USER_REFRESH_INTERVAL_MS: "60000",
        PROJECT_REGISTRY_SHUTDOWN_TIMEOUT_MS: "8000",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (child.stdout == null || typeof child.stdout === "number") throw new Error("daemon stdout pipe was not created")
    if (child.stderr == null || typeof child.stderr === "number") throw new Error("daemon stderr pipe was not created")
    let stdout = ""
    let stderr = ""
    outputComplete = Promise.all([
      outputRead(child.stdout, (text) => (stdout += text)),
      outputRead(child.stderr, (text) => (stderr += text)),
    ])

    async function socketRequest(path: string): Promise<Response> {
      return fetch(`http://localhost${path}`, {
        method: "POST",
        unix: socketPath,
      } as RequestInit & { unix: string })
    }

    async function ready(): Promise<void> {
      const diagnostics = () =>
        `daemon did not become ready; exitCode=${child?.exitCode} socket=${socketPath} stdout=${stdout} stderr=${stderr}`
      await waitFor(async () => {
        if (child?.exitCode !== null) {
          await outputComplete
          throw new Error(diagnostics())
        }
        try {
          const response = await fetch(`http://127.0.0.1:${webPort}/health/ready`)
          return response.status === 200 ? true : undefined
        } catch {
          return undefined
        }
      }, diagnostics)
    }

    return {
      child,
      directory,
      loadAckResolve,
      loadAcknowledged: () => loadAcknowledged,
      loadSeen,
      outputComplete,
      ready,
      server,
      socketRequest,
      socketPath,
      stderr: () => stderr,
      stdout: () => stdout,
    }
  } catch (error) {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
    await outputComplete
    server?.stop(true)
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function fixtureClose(fixture: Awaited<ReturnType<typeof fixtureCreate>>): Promise<void> {
  if (fixture.child.exitCode === null) {
    fixture.child.kill("SIGKILL")
    await fixture.child.exited
  }
  await fixture.outputComplete
  fixture.server.stop(true)
  await rm(fixture.directory, { recursive: true, force: true })
}

test("a real daemon drains a pending Caddy load before exiting successfully on SIGTERM", async () => {
  const fixture = await fixtureCreate()
  try {
    await fixture.ready()
    const publish = fixture.socketRequest("/api/v1/caddy/regenerate")
    await fixture.loadSeen
    fixture.child.kill("SIGTERM")

    const rejectedPublish = await fixture.socketRequest("/api/v1/caddy/regenerate")
    expect(rejectedPublish.status).toBe(503)
    await responseRead(rejectedPublish)
    expect(fixture.child.exitCode).toBeNull()

    fixture.loadAckResolve?.()
    expect(await Promise.race([fixture.child.exited, Bun.sleep(10_000).then(() => -1)])).toBe(0)
    await fixture.outputComplete
    const publishResponse = await publish
    await responseRead(publishResponse)
    expect(fixture.loadAcknowledged()).toBe(true)
    expect(fixture.stderr()).not.toContain("shutdown degraded")
  } finally {
    await fixtureClose(fixture)
  }
})

test("a real daemon exits degraded when the admin connection drops during an unacknowledged load", async () => {
  const fixture = await fixtureCreate()
  try {
    await fixture.ready()
    const publish = fixture.socketRequest("/api/v1/caddy/regenerate")
    await fixture.loadSeen
    fixture.child.kill("SIGTERM")
    fixture.server.stop(true)

    const [exitCode, publishResponse] = await Promise.all([
      Promise.race([fixture.child.exited, Bun.sleep(10_000).then(() => -1)]),
      publish,
    ])
    await fixture.outputComplete
    expect(exitCode).toBe(1)
    expect(publishResponse.status).toBe(500)
    await responseRead(publishResponse)
    expect(fixture.stderr()).toContain("daemon shutdown degraded")
  } finally {
    await fixtureClose(fixture)
  }
})
