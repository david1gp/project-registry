import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectRegistryDaemonPrivateDnsTrackingState } from "./ProjectRegistryDaemonPrivateDnsTrackingState.js"
import { projectRegistryDaemonPrivateDnsTrackingCreate } from "./projectRegistryDaemonPrivateDnsTrackingCreate.js"
import { projectRegistryDaemonPrivateDnsTrackingFilesystemDefault } from "./projectRegistryDaemonPrivateDnsTrackingFilesystemDefault.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

function state(): ProjectRegistryDaemonPrivateDnsTrackingState {
  return {
    version: 1,
    hosts: [
      {
        hostname: "app.wonder1.de",
        owner: "leo",
        zone: "wonder1.de",
        nodeAddress: "100.122.200.114",
        projectKeys: [{ owner: "leo", name: "app" }],
      },
    ],
  }
}

async function temporaryPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-private-dns-tracking-"))
  temporaryDirectories.push(directory)
  return { directory, path: join(directory, "server-ip.private-dns.json") }
}

describe("projectRegistryDaemonPrivateDnsTrackingCreate", () => {
  test("treats a missing daemon-local file as empty state", async () => {
    const location = await temporaryPath()
    const trackerR = projectRegistryDaemonPrivateDnsTrackingCreate({
      path: location.path,
      filesystem: projectRegistryDaemonPrivateDnsTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    await expect(trackerR.data.read()).resolves.toEqual({ success: true, data: { version: 1, hosts: [] } })
  })

  test("writes atomically with private modes and recovers after recreation", async () => {
    const location = await temporaryPath()
    const filesystem = projectRegistryDaemonPrivateDnsTrackingFilesystemDefault()
    const trackerR = projectRegistryDaemonPrivateDnsTrackingCreate({ path: location.path, filesystem })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    await expect(trackerR.data.write(state())).resolves.toEqual({ success: true, data: undefined })
    const fileStat = await stat(location.path)
    const directoryStat = await stat(location.directory)
    expect(fileStat.mode & 0o777).toBe(0o600)
    expect(directoryStat.mode & 0o777).toBe(0o700)
    await expect(readFile(location.path, "utf8")).resolves.toContain('"version":1')
    await expect(stat(`${location.path}.tmp-${process.pid}`)).rejects.toMatchObject({ code: "ENOENT" })

    const restartedR = projectRegistryDaemonPrivateDnsTrackingCreate({ path: location.path, filesystem })
    expect(restartedR.success).toBe(true)
    if (!restartedR.success) return
    await expect(restartedR.data.read()).resolves.toEqual({ success: true, data: state() })
  })

  test("returns a Result error for corrupt state without exposing its contents", async () => {
    const location = await temporaryPath()
    await writeFile(location.path, JSON.stringify({ version: 99, secret: "token" }))
    const trackerR = projectRegistryDaemonPrivateDnsTrackingCreate({
      path: location.path,
      filesystem: projectRegistryDaemonPrivateDnsTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    const result = await trackerR.data.read()
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("Private DNS tracking state is corrupt")
    expect(JSON.stringify(result)).not.toContain("token")
  })

  test("rejects duplicate hostnames", async () => {
    const location = await temporaryPath()
    const trackerR = projectRegistryDaemonPrivateDnsTrackingCreate({
      path: location.path,
      filesystem: projectRegistryDaemonPrivateDnsTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    const duplicated = state()
    duplicated.hosts.push({ ...duplicated.hosts[0]! })
    const result = await trackerR.data.write(duplicated)
    expect(result.success).toBe(false)
  })
})
