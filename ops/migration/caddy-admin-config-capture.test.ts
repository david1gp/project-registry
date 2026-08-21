import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const captureScript = join(import.meta.dir, "caddy-admin-config-capture.ts")

async function capture(url: string, output: string): Promise<{ exitCode: number; stderr: string }> {
  const process = Bun.spawn(["bun", "run", captureScript, "--url", url, "--output", output], {
    stderr: "pipe",
    stdout: "pipe",
  })
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited])
  return { exitCode, stderr }
}

test("captures the current /config/ response with a read-only GET", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-caddy-capture-"))
  const currentConfig = { running: true, marker: "current-admin-config" }
  const requests: { method: string; pathname: string }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ method: request.method, pathname: url.pathname })
      if (url.pathname !== "/config/") return new Response("not found", { status: 404 })
      return Response.json(currentConfig)
    },
  })

  try {
    const output = join(directory, "captured.json")
    const result = await capture(new URL("/config/", server.url).toString(), output)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(requests).toEqual([{ method: "GET", pathname: "/config/" }])
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(currentConfig)
    expect((await stat(output)).mode & 0o777).toBe(0o600)
  } finally {
    server.stop()
    await rm(directory, { force: true, recursive: true })
  }
})

test("rejects malformed, unsupported, and non-loopback capture URLs without a request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-caddy-capture-invalid-"))
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests += 1
      return Response.json({})
    },
  })

  try {
    const invalidUrls = [
      "not-a-url",
      "ftp://127.0.0.1:2019/config/",
      "http://192.0.2.1:2019/config/",
      "http://127.0.0.1.evil.example/config/",
    ]
    for (const [index, url] of invalidUrls.entries()) {
      const result = await capture(url, join(directory, `invalid-${index}.json`))
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Caddy config capture failed:")
    }
    expect(requests).toBe(0)
  } finally {
    server.stop()
    await rm(directory, { force: true, recursive: true })
  }
})

test("aborts a capture whose response does not complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-caddy-capture-timeout-"))
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests += 1
      return new Promise<Response>(() => {})
    },
  })

  try {
    const result = await capture(new URL("/config/", server.url).toString(), join(directory, "timed-out.json"))

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Caddy admin API request timed out after 2000ms")
    expect(requests).toBe(1)
  } finally {
    server.stop()
    await rm(directory, { force: true, recursive: true })
  }
})
