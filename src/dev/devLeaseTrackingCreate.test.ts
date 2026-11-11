import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { devLeaseTrackingCreate } from "./devLeaseTrackingCreate.js"
import { devLeaseTrackingFilesystemDefault } from "./devLeaseTrackingFilesystemDefault.js"
import type { DevLeaseTrackingState } from "./devLeaseTrackingState.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

function leaseState(port: number, name: string): DevLeaseTrackingState {
  return {
    version: 1,
    leases: [
      {
        projectKey: { owner: "tim", name },
        serviceId: "default",
        user: "tim",
        port,
        unit: `dev-tim-${name}.service`,
        hostname: `tim-${name}.wonder1.de`,
        state: "active",
        ttlMs: 14_400_000,
        lastSeenAt: 1_700_000_000_000,
        createdAt: 1_700_000_000_000,
      },
    ],
  }
}

async function temporaryPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-dev-lease-tracking-"))
  temporaryDirectories.push(directory)
  return { directory, path: join(directory, "dev-leases.json") }
}

describe("devLeaseTrackingCreate", () => {
  test("treats a missing daemon-local file as empty state", async () => {
    const location = await temporaryPath()
    const trackerR = devLeaseTrackingCreate({
      path: location.path,
      filesystem: devLeaseTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    await expect(trackerR.data.read()).resolves.toEqual({ success: true, data: { version: 1, leases: [] } })
  })

  test("writes atomically with private modes and recovers after recreation", async () => {
    const location = await temporaryPath()
    const filesystem = devLeaseTrackingFilesystemDefault()
    const trackerR = devLeaseTrackingCreate({ path: location.path, filesystem })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    await expect(trackerR.data.write(leaseState(4300, "akademie"))).resolves.toEqual({
      success: true,
      data: undefined,
    })
    const fileStat = await stat(location.path)
    const directoryStat = await stat(location.directory)
    expect(fileStat.mode & 0o777).toBe(0o600)
    expect(directoryStat.mode & 0o777).toBe(0o700)
    await expect(readFile(location.path, "utf8")).resolves.toContain('"version":1')
    await expect(stat(`${location.path}.tmp-${process.pid}`)).rejects.toMatchObject({ code: "ENOENT" })

    const restartedR = devLeaseTrackingCreate({ path: location.path, filesystem })
    expect(restartedR.success).toBe(true)
    if (!restartedR.success) return
    await expect(restartedR.data.read()).resolves.toEqual({
      success: true,
      data: leaseState(4300, "akademie"),
    })
  })

  test("returns a Result error for corrupt state without exposing its contents", async () => {
    const location = await temporaryPath()
    await writeFile(location.path, JSON.stringify({ version: 1, leases: [{ secret: "token" }] }))
    const trackerR = devLeaseTrackingCreate({
      path: location.path,
      filesystem: devLeaseTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    const result = await trackerR.data.read()
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("Dev lease tracking state is corrupt")
    expect(JSON.stringify(result)).not.toContain("token")
  })

  test("rejects duplicate hostnames on write", async () => {
    const location = await temporaryPath()
    const trackerR = devLeaseTrackingCreate({
      path: location.path,
      filesystem: devLeaseTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    const duplicated = leaseState(4300, "akademie")
    duplicated.leases.push({ ...duplicated.leases[0]!, port: 4301 })
    await expect(trackerR.data.write(duplicated)).resolves.toMatchObject({ success: false })
  })

  test("applies concurrent writes in call order", async () => {
    const location = await temporaryPath()
    const trackerR = devLeaseTrackingCreate({
      path: location.path,
      filesystem: devLeaseTrackingFilesystemDefault(),
    })
    expect(trackerR.success).toBe(true)
    if (!trackerR.success) return

    const first = trackerR.data.write(leaseState(4300, "akademie"))
    const second = trackerR.data.write(leaseState(4301, "werkstatt"))
    await expect(first).resolves.toMatchObject({ success: true })
    await expect(second).resolves.toMatchObject({ success: true })
    await expect(trackerR.data.read()).resolves.toEqual({
      success: true,
      data: leaseState(4301, "werkstatt"),
    })
  })
})
