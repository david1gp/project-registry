import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectRegistryDaemonCloudflareDnsTrackingState } from "./ProjectRegistryDaemonCloudflareDnsTrackingState.js"
import { projectRegistryDaemonCloudflareDnsTrackingCreate } from "./projectRegistryDaemonCloudflareDnsTrackingCreate.js"
import { projectRegistryDaemonCloudflareDnsTrackingFilesystemDefault } from "./projectRegistryDaemonCloudflareDnsTrackingFilesystemDefault.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

function state(): ProjectRegistryDaemonCloudflareDnsTrackingState {
  return {
    version: 1,
    records: [
      {
        zoneId: "zone-id",
        zoneName: "example.com",
        id: "record-id",
        name: "app.example.com",
        type: "A",
        content: "203.0.113.8",
        ttl: 1,
        proxied: true,
        projectKeys: [{ owner: "leo", name: "app" }],
      },
    ],
  }
}

async function temporaryPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-dns-tracking-"))
  temporaryDirectories.push(directory)
  return { directory, path: join(directory, "server-ip-dns.json") }
}

describe("projectRegistryDaemonCloudflareDnsTrackingCreate", () => {
  test("treats a missing daemon-local file as empty state", async () => {
    const location = await temporaryPath()
    const trackerR = projectRegistryDaemonCloudflareDnsTrackingCreate({
      path: location.path,
      filesystem: projectRegistryDaemonCloudflareDnsTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    await expect(trackerR.data.read()).resolves.toEqual({ success: true, data: { version: 1, records: [] } })
  })

  test("writes atomically with private modes and recovers after recreation", async () => {
    const location = await temporaryPath()
    const filesystem = projectRegistryDaemonCloudflareDnsTrackingFilesystemDefault()
    const trackerR = projectRegistryDaemonCloudflareDnsTrackingCreate({ path: location.path, filesystem })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    await expect(trackerR.data.write(state())).resolves.toEqual({ success: true, data: undefined })
    const fileStat = await stat(location.path)
    const directoryStat = await stat(location.directory)
    expect(fileStat.mode & 0o777).toBe(0o600)
    expect(directoryStat.mode & 0o777).toBe(0o700)
    await expect(readFile(location.path, "utf8")).resolves.toContain('"version":1')
    await expect(stat(`${location.path}.tmp-${process.pid}`)).rejects.toMatchObject({ code: "ENOENT" })

    const restartedR = projectRegistryDaemonCloudflareDnsTrackingCreate({ path: location.path, filesystem })
    expect(restartedR.success).toBe(true)
    if (!restartedR.success) return
    await expect(restartedR.data.read()).resolves.toEqual({ success: true, data: state() })
  })

  test("returns a Result error for corrupt state without exposing its contents", async () => {
    const location = await temporaryPath()
    await writeFile(location.path, JSON.stringify({ version: 99, secret: "token" }))
    const trackerR = projectRegistryDaemonCloudflareDnsTrackingCreate({
      path: location.path,
      filesystem: projectRegistryDaemonCloudflareDnsTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    const result = await trackerR.data.read()
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("Cloudflare DNS tracking state is corrupt")
    expect(result.errorMessage).not.toContain("token")
  })

  test("cleans the temporary file when an atomic rename fails", async () => {
    const files = new Map<string, string>()
    const unlinks: string[] = []
    const trackerR = projectRegistryDaemonCloudflareDnsTrackingCreate({
      path: "/tmp/tracking.json",
      filesystem: {
        async readFile(path) {
          const value = files.get(path)
          if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
          return value
        },
        async mkdir() {},
        async writeFile(path, value) {
          files.set(path, value)
        },
        async rename() {
          throw new Error("rename failed")
        },
        async unlink(path) {
          unlinks.push(path)
          files.delete(path)
        },
      },
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    const result = await trackerR.data.write(state())
    expect(result.success).toBe(false)
    expect(unlinks).toEqual([`/tmp/tracking.json.tmp-${process.pid}`])
    expect(files.has(`/tmp/tracking.json.tmp-${process.pid}`)).toBe(false)
  })
})
