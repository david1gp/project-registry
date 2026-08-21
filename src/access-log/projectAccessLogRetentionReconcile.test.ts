import { describe, expect, test } from "bun:test"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectAccessLogCaddyRetention } from "./projectAccessLogCaddyRetention.js"
import { projectAccessLogId } from "./projectAccessLogId.js"
import { projectAccessLogOpenat2 } from "./projectAccessLogOpenat2.js"
import { projectAccessLogRetentionMaximumActiveProjectIds } from "./projectAccessLogRetentionMaximumActiveProjectIds.js"
import {
  type ProjectAccessLogRetentionReconcileOptions,
  projectAccessLogRetentionReconcile,
} from "./projectAccessLogRetentionReconcile.js"

const retentionMs = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000
const quarantineGraceMs = 24 * 60 * 60 * 1_000
const metadataName = ".project-registry-retention.json"
const quarantineName = "quarantine"
const metadataTemporaryName = `${metadataName}.tmp-00000000-0000-4000-8000-000000000001`

type RetentionFileSystem = NonNullable<ProjectAccessLogRetentionReconcileOptions["filesystem"]>

function retentionFileSystemCreate(failPurpose?: string): { filesystem: RetentionFileSystem; purposes: string[] } {
  const purposes: string[] = []
  const filesystem: RetentionFileSystem = {
    syncDirectory: async (_directory, purpose) => {
      purposes.push(purpose)
      if (purpose === failPurpose) throw new Error(`injected fsync failure: ${purpose}`)
    },
  }
  return { filesystem, purposes }
}

async function fixtureCreate() {
  const root = await mkdtemp(join(tmpdir(), "project-registry-retention-"))
  await mkdir(join(root, "projects"))
  return {
    root,
    cleanup: () => rm(root, { force: true, recursive: true }),
  }
}

function projectId(owner: string, name: string): string {
  return projectAccessLogId({ owner, name })
}

function activeProjectIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => projectId("active-owner", `project-${index}`))
}

async function projectDirectoryCreate(root: string, id: string): Promise<string> {
  const directory = join(root, "projects", id)
  await mkdir(directory)
  await writeFile(join(directory, "access.jsonl"), "")
  return directory
}

async function bindMountTry(source: string, target: string): Promise<boolean> {
  if (process.platform !== "linux") return false
  try {
    const command = Bun.spawn(["mount", "--bind", source, target], { stderr: "ignore", stdout: "ignore" })
    return (await command.exited) === 0
  } catch {
    return false
  }
}

async function bindUnmount(target: string): Promise<void> {
  if (process.platform !== "linux") return
  try {
    const command = Bun.spawn(["umount", target], { stderr: "ignore", stdout: "ignore" })
    await command.exited
  } catch {
    // Test cleanup is best effort; the mount helper only runs when the caller has mount privileges.
  }
}

describe("projectAccessLogRetentionReconcile", () => {
  test("keeps active project directories", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "active")
      const directory = await projectDirectoryCreate(fixture.root, id)

      const result = await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [id], now: 100 })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(directory)).isDirectory()).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("retains a newly inactive directory for seven days", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "recent")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [id], now: 100 })

      const result = await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 200 })

      expect(result.success).toBe(true)
      expect((await lstat(directory)).isDirectory()).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("moves an expired inactive directory to quarantine without deleting it", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "expired")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toEqual({ success: true, data: true })
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" })
      const quarantinedDirectory = join(fixture.root, quarantineName, id)
      expect((await lstat(quarantinedDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(quarantinedDirectory, "access.jsonl"), "utf8")).toBe("")
      expect(await readFile(join(quarantinedDirectory, metadataName), "utf8")).toBe(
        `{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":${retentionMs + 1}}`,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("fsyncs the quarantine namespace before both rename parent descriptors", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "fsync-order")
      await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const filesystem = retentionFileSystemCreate()

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toEqual({ success: true, data: true })
      expect(filesystem.purposes).toEqual([
        "quarantine-namespace",
        "quarantine-rename-source",
        "quarantine-rename-destination",
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves the live directory when quarantine namespace fsync fails", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "fsync-namespace-failure")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const filesystem = retentionFileSystemCreate("quarantine-namespace")

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("durable") })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect((await lstat(join(fixture.root, quarantineName))).isDirectory()).toBe(true)
      await expect(lstat(join(fixture.root, quarantineName, id))).rejects.toMatchObject({ code: "ENOENT" })
      expect(filesystem.purposes).toEqual(["quarantine-namespace"])
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves an ambiguous rename when a parent fsync fails", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "fsync-rename-failure")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const filesystem = retentionFileSystemCreate("quarantine-rename-destination")

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("durable") })
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" })
      const quarantinedDirectory = join(fixture.root, quarantineName, id)
      expect((await lstat(quarantinedDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(quarantinedDirectory, metadataName), "utf8")).toBe(
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )
      expect(filesystem.purposes).toEqual([
        "quarantine-namespace",
        "quarantine-rename-source",
        "quarantine-rename-destination",
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  test("treats a missing root as a no-op", async () => {
    const fixture = await fixtureCreate()
    try {
      const missingRoot = join(fixture.root, "missing")

      expect(await projectAccessLogRetentionReconcile({ root: missingRoot, activeProjectIds: [], now: 0 })).toEqual({
        success: true,
        data: true,
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test("accepts exactly 1,024 raw active project IDs", async () => {
    const fixture = await fixtureCreate()
    try {
      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: activeProjectIds(projectAccessLogRetentionMaximumActiveProjectIds),
        now: 0,
      })

      expect(result).toEqual({ success: true, data: true })
    } finally {
      await fixture.cleanup()
    }
  })

  test("rejects 1,025 raw active project IDs without mutating or deleting metadata", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "over-limit")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const metadataBefore = await readFile(join(directory, metadataName), "utf8")

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: activeProjectIds(projectAccessLogRetentionMaximumActiveProjectIds + 1),
        now: retentionMs + 1,
      })

      expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("1024") })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect(await readFile(join(directory, metadataName), "utf8")).toBe(metadataBefore)
    } finally {
      await fixture.cleanup()
    }
  })

  test("rejects duplicate and invalid active project IDs before mutating metadata", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "invalid-input")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const metadataBefore = await readFile(join(directory, metadataName), "utf8")

      const duplicate = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [id, id],
        now: 0,
      })
      const invalid = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [id, "invalid-project-id"],
        now: retentionMs + 1,
      })

      expect(duplicate).toMatchObject({ success: false, errorMessage: expect.stringContaining("unique") })
      expect(invalid).toMatchObject({ success: false, errorMessage: expect.stringContaining("invalid") })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect(await readFile(join(directory, metadataName), "utf8")).toBe(metadataBefore)
    } finally {
      await fixture.cleanup()
    }
  })

  test("serializes concurrent reconciliations in call order", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "serialized")
      const directory = await projectDirectoryCreate(fixture.root, id)
      const first = projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [id], now: 0 })
      const second = projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })

      expect(await Promise.all([first, second])).toEqual([
        { success: true, data: true },
        { success: true, data: true },
      ])
      expect(await readFile(join(directory, metadataName), "utf8")).toBe(
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("returns a typed openat2 error for a descriptor-relative path escape", async () => {
    const fixture = await fixtureCreate()
    let parent: Awaited<ReturnType<typeof open>> | undefined
    try {
      parent = await open(fixture.root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
      const result = await projectAccessLogOpenat2({
        directoryFd: parent.fd,
        name: "..",
        flags: constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
        path: join(fixture.root, ".."),
      })

      expect(result).toMatchObject({
        success: false,
        op: "projectAccessLogOpenat2",
        errorMessage: expect.stringContaining("mount boundary"),
      })
    } finally {
      await parent?.close()
      await fixture.cleanup()
    }
  })

  test("returns a typed openat2 error for an invalid parent descriptor", async () => {
    const result = await projectAccessLogOpenat2({
      directoryFd: 999_999,
      name: ".",
      flags: constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      path: "/invalid-parent",
    })

    expect(result).toMatchObject({
      success: false,
      op: "projectAccessLogOpenat2",
      errorMessage: expect.stringContaining("could not open"),
    })
  })

  test("preserves malformed entries and ambiguous metadata", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "malformed")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await writeFile(join(directory, metadataName), "not-json")
      await writeFile(join(fixture.root, "projects", "not-a-project-id"), "ignored")
      const unsafeModeName = `${metadataName}.tmp-00000000-0000-4000-8000-000000000002`
      const invalidContentName = `${metadataName}.tmp-00000000-0000-4000-8000-000000000004`
      const symlinkName = `${metadataName}.tmp-00000000-0000-4000-8000-000000000003`
      await writeFile(join(directory, unsafeModeName), "lookalike", { mode: 0o644 })
      await writeFile(join(directory, invalidContentName), "lookalike", { mode: 0o600 })
      await symlink(join(directory, metadataName), join(directory, symlinkName))

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result.success).toBe(true)
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect((await lstat(join(fixture.root, "projects", "not-a-project-id"))).isFile()).toBe(true)
      expect((await lstat(join(directory, unsafeModeName))).isFile()).toBe(true)
      expect((await lstat(join(directory, invalidContentName))).isFile()).toBe(true)
      expect((await lstat(join(directory, symlinkName))).isSymbolicLink()).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("stops before enumerating an excessive projects directory", async () => {
    const fixture = await fixtureCreate()
    try {
      for (let index = 0; index < 1_025; index += 1) {
        await writeFile(join(fixture.root, "projects", `malformed-${index}`), "")
      }
      const id = projectId("alice", "expired-with-excessive-entries")
      const directory = await projectDirectoryCreate(fixture.root, id)

      const result = await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })

      expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("entry limit") })
      expect((await lstat(directory)).isDirectory()).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("does not follow a symlinked project directory", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-outside-"))
    try {
      const id = projectId("alice", "linked")
      const outsideFile = join(outside, "outside.txt")
      await writeFile(outsideFile, "keep")
      await symlink(outside, join(fixture.root, "projects", id))

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result.success).toBe(true)
      expect((await lstat(join(fixture.root, "projects", id))).isSymbolicLink()).toBe(true)
      expect((await lstat(outsideFile)).isFile()).toBe(true)
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("rejects a symlinked projects boundary", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-outside-"))
    try {
      const id = projectId("alice", "outside")
      await mkdir(join(outside, "projects"))
      const outsideDirectory = await projectDirectoryCreate(outside, id)
      await rm(join(fixture.root, "projects"), { recursive: true })
      await symlink(join(outside, "projects"), join(fixture.root, "projects"))

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toMatchObject({ success: false })
      expect((await lstat(outsideDirectory)).isDirectory()).toBe(true)
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("rejects a same-device bind-mounted projects boundary when mount privileges permit", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-bind-projects-"))
    let mounted = false
    try {
      const id = projectId("alice", "bind-projects")
      const outsideProjects = join(outside, "projects")
      await mkdir(outsideProjects)
      const outsideDirectory = await projectDirectoryCreate(outside, id)
      mounted = await bindMountTry(outsideProjects, join(fixture.root, "projects"))
      if (!mounted) return

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("mount boundary") })
      expect((await lstat(outsideDirectory)).isDirectory()).toBe(true)
      await expect(lstat(join(outsideDirectory, metadataName))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      if (mounted) await bindUnmount(join(fixture.root, "projects"))
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("rejects a same-device bind-mounted log root when mount privileges permit", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-bind-root-"))
    let mounted = false
    try {
      const id = projectId("alice", "bind-root")
      await mkdir(join(outside, "projects"))
      const outsideDirectory = await projectDirectoryCreate(outside, id)
      mounted = await bindMountTry(outside, fixture.root)
      if (!mounted) return

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("mount boundary") })
      expect((await lstat(outsideDirectory)).isDirectory()).toBe(true)
      await expect(lstat(join(outsideDirectory, metadataName))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      if (mounted) await bindUnmount(fixture.root)
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("skips a same-device bind-mounted project directory when mount privileges permit", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-bind-project-"))
    let mounted = false
    try {
      const id = projectId("alice", "bind-project")
      const target = join(fixture.root, "projects", id)
      const source = join(outside, id)
      await mkdir(target)
      await mkdir(source)
      await writeFile(join(source, "access.jsonl"), "outside")
      mounted = await bindMountTry(source, target)
      if (!mounted) return

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toEqual({ success: true, data: true })
      expect(await readFile(join(target, "access.jsonl"), "utf8")).toBe("outside")
      await expect(lstat(join(source, metadataName))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      if (mounted) await bindUnmount(join(fixture.root, "projects", projectId("alice", "bind-project")))
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("preserves a same-device bind-mounted deletion candidate when mount privileges permit", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-bind-delete-"))
    let mounted = false
    try {
      const id = projectId("alice", "bind-deletion")
      const directory = join(fixture.root, quarantineName, id)
      const target = join(directory, "access.jsonl")
      const source = join(outside, "access.jsonl")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(target, "underlying")
      await writeFile(source, "mounted")
      await writeFile(
        join(directory, metadataName),
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )
      mounted = await bindMountTry(source, target)
      if (!mounted) return

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: quarantineGraceMs,
      })

      expect(result).toEqual({ success: true, data: true })
      expect(await readFile(target, "utf8")).toBe("mounted")
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect(await readFile(join(directory, metadataName), "utf8")).toBe(
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )
    } finally {
      if (mounted)
        await bindUnmount(join(fixture.root, quarantineName, projectId("alice", "bind-deletion"), "access.jsonl"))
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("preserves a project with a symlinked retention metadata file", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-outside-"))
    try {
      const id = projectId("alice", "metadata-link")
      const directory = await projectDirectoryCreate(fixture.root, id)
      const outsideMetadata = join(outside, metadataName)
      await writeFile(outsideMetadata, JSON.stringify({ version: 1, state: "inactive", inactiveAt: 0 }))
      await symlink(outsideMetadata, join(directory, metadataName))

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result.success).toBe(true)
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect((await lstat(outsideMetadata)).isFile()).toBe(true)
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("preserves a quarantine collision and the expired live directory", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "quarantine-collision")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const quarantineDirectory = join(fixture.root, quarantineName)
      await mkdir(quarantineDirectory, { mode: 0o700 })
      const collision = join(quarantineDirectory, id)
      await writeFile(collision, "preserve")

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect((await lstat(collision)).isFile()).toBe(true)
      expect(await readFile(collision, "utf8")).toBe("preserve")
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves an empty quarantine collision without replacing its inode", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "empty-quarantine-collision")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const quarantineDirectory = join(fixture.root, quarantineName)
      await mkdir(join(quarantineDirectory, id), { mode: 0o700, recursive: true })

      const before = await lstat(join(quarantineDirectory, id))
      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect((await lstat(join(quarantineDirectory, id))).ino).toBe(before.ino)
    } finally {
      await fixture.cleanup()
    }
  })

  test("adopts a crash-left quarantine only from expired inactive metadata", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "crash-left")
      const quarantineDirectory = join(fixture.root, quarantineName, id)
      await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(quarantineDirectory, "access.jsonl"), "old")
      await writeFile(join(quarantineDirectory, metadataName), '{"version":1,"state":"inactive","inactiveAt":0}')

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(quarantineDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(quarantineDirectory, metadataName), "utf8")).toBe(
        `{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":${retentionMs + 1}}`,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves an ambiguous crash-left quarantine without inactive metadata", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "ambiguous-crash-left")
      const quarantineDirectory = join(fixture.root, quarantineName, id)
      await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(quarantineDirectory, "access.jsonl"), "old")
      const emptyId = projectId("alice", "empty-crash-left")
      const emptyDirectory = join(fixture.root, quarantineName, emptyId)
      await mkdir(emptyDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(emptyDirectory, metadataTemporaryName), "", { mode: 0o600 })
      const filesystem = retentionFileSystemCreate()

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(quarantineDirectory)).isDirectory()).toBe(true)
      await expect(lstat(join(quarantineDirectory, metadataName))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(lstat(emptyDirectory)).rejects.toMatchObject({ code: "ENOENT" })
      expect(filesystem.purposes).toEqual(["metadata-namespace", "quarantine-namespace"])
    } finally {
      await fixture.cleanup()
    }
  })

  test("does not follow a symlinked quarantine boundary", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-quarantine-outside-"))
    try {
      const id = projectId("alice", "quarantine-link")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      await symlink(outside, join(fixture.root, quarantineName))

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toMatchObject({ success: false })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect((await lstat(join(fixture.root, quarantineName))).isSymbolicLink()).toBe(true)
      expect((await lstat(outside)).isDirectory()).toBe(true)
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("preserves a crash-left quarantine when a live symlink collides with its ID", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-live-link-"))
    try {
      const id = projectId("alice", "live-link-collision")
      const quarantineDirectory = join(fixture.root, quarantineName, id)
      await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(quarantineDirectory, "access.jsonl"), "old")
      await writeFile(join(quarantineDirectory, metadataName), '{"version":1,"state":"inactive","inactiveAt":0}')
      await symlink(outside, join(fixture.root, "projects", id))

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
      })

      expect(result).toEqual({ success: true, data: true })
      expect(await readFile(join(quarantineDirectory, metadataName), "utf8")).toBe(
        '{"version":1,"state":"inactive","inactiveAt":0}',
      )
      expect((await lstat(join(fixture.root, "projects", id))).isSymbolicLink()).toBe(true)
      expect((await lstat(outside)).isDirectory()).toBe(true)
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("reactivation keeps quarantine separate from the fresh live directory", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "reactivated")
      const oldDirectory = await projectDirectoryCreate(fixture.root, id)
      await writeFile(join(oldDirectory, "access.jsonl"), "old")
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: retentionMs + 1 })

      const freshDirectory = await projectDirectoryCreate(fixture.root, id)
      await writeFile(join(freshDirectory, "access.jsonl"), "fresh")
      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [id],
        now: retentionMs + 2,
      })

      expect(result).toEqual({ success: true, data: true })
      expect(await readFile(join(freshDirectory, "access.jsonl"), "utf8")).toBe("fresh")
      expect(await readFile(join(freshDirectory, metadataName), "utf8")).toBe('{"version":1,"state":"active"}')
      expect(await readFile(join(fixture.root, quarantineName, id, "access.jsonl"), "utf8")).toBe("old")
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves an unverified source replacement in quarantine", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "source-replacement-race")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const replacedDirectory = join(fixture.root, "replaced-source")
      let freshLiveInode: number | undefined
      const filesystem = retentionFileSystemCreate()
      filesystem.filesystem.beforeQuarantineRename = async () => {
        await rename(directory, replacedDirectory)
        const freshDirectory = await projectDirectoryCreate(fixture.root, id)
        await writeFile(join(freshDirectory, "access.jsonl"), "fresh")
        await writeFile(join(freshDirectory, metadataName), '{"version":1,"state":"active"}')
        freshLiveInode = (await lstat(freshDirectory)).ino
      }

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toEqual({ success: true, data: true })
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" })
      expect((await lstat(join(fixture.root, quarantineName, id))).ino).toBe(freshLiveInode!)
      expect(await readFile(join(fixture.root, quarantineName, id, "access.jsonl"), "utf8")).toBe("fresh")
      expect(await readFile(join(fixture.root, quarantineName, id, metadataName), "utf8")).toBe(
        '{"version":1,"state":"active"}',
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves a mismatched quarantine and a fresh live directory", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "quarantine-replacement-race")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const replacedDirectory = join(fixture.root, "replaced-source")
      let freshLiveInode: number | undefined
      let mismatchedQuarantineInode: number | undefined
      const filesystem = retentionFileSystemCreate()
      filesystem.filesystem.beforeQuarantineRename = async () => {
        await rename(directory, replacedDirectory)
        const replacementDirectory = await projectDirectoryCreate(fixture.root, id)
        await writeFile(join(replacementDirectory, "access.jsonl"), "replacement")
      }
      filesystem.filesystem.afterQuarantineRename = async () => {
        const quarantineDirectory = join(fixture.root, quarantineName)
        await rename(join(quarantineDirectory, id), join(quarantineDirectory, "replaced-quarantine"))

        const mismatchedDirectory = join(quarantineDirectory, id)
        await mkdir(mismatchedDirectory, { mode: 0o700 })
        await writeFile(join(mismatchedDirectory, "access.jsonl"), "mismatched")
        await writeFile(
          join(mismatchedDirectory, metadataName),
          '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
        )
        mismatchedQuarantineInode = (await lstat(mismatchedDirectory)).ino
        const freshDirectory = await projectDirectoryCreate(fixture.root, id)
        await writeFile(join(freshDirectory, "access.jsonl"), "fresh")
        await writeFile(join(freshDirectory, metadataName), '{"version":1,"state":"active"}')
        freshLiveInode = (await lstat(freshDirectory)).ino
      }

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(join(fixture.root, "projects", id))).ino).toBe(freshLiveInode!)
      expect((await lstat(join(fixture.root, quarantineName, id))).ino).toBe(mismatchedQuarantineInode!)
      expect(await readFile(join(fixture.root, "projects", id, "access.jsonl"), "utf8")).toBe("fresh")
      expect(await readFile(join(fixture.root, quarantineName, id, "access.jsonl"), "utf8")).toBe("mismatched")
      expect(await readFile(join(fixture.root, quarantineName, id, metadataName), "utf8")).toBe(
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves a malicious symlink quarantine replacement", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-symlink-target-"))
    try {
      const id = projectId("alice", "quarantine-symlink-replacement")
      await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const filesystem = retentionFileSystemCreate()
      filesystem.filesystem.afterQuarantineRename = async () => {
        const quarantineDirectory = join(fixture.root, quarantineName)
        await rename(join(quarantineDirectory, id), join(quarantineDirectory, "replaced-source"))
        await symlink(outside, join(quarantineDirectory, id))
      }

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toEqual({ success: true, data: true })
      await expect(lstat(join(fixture.root, "projects", id))).rejects.toMatchObject({ code: "ENOENT" })
      expect((await lstat(join(fixture.root, quarantineName, id))).isSymbolicLink()).toBe(true)
      expect((await lstat(outside)).isDirectory()).toBe(true)
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("preserves a malicious regular-directory quarantine replacement", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "quarantine-directory-replacement")
      await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const filesystem = retentionFileSystemCreate()
      let replacementInode: number | undefined
      filesystem.filesystem.afterQuarantineRename = async () => {
        const quarantineDirectory = join(fixture.root, quarantineName)
        await rename(join(quarantineDirectory, id), join(quarantineDirectory, "replaced-source"))
        const replacement = join(quarantineDirectory, id)
        await mkdir(replacement, { mode: 0o700 })
        await writeFile(join(replacement, "access.jsonl"), "replacement")
        replacementInode = (await lstat(replacement)).ino
      }

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toEqual({ success: true, data: true })
      await expect(lstat(join(fixture.root, "projects", id))).rejects.toMatchObject({ code: "ENOENT" })
      expect((await lstat(join(fixture.root, quarantineName, id))).ino).toBe(replacementInode!)
      expect(await readFile(join(fixture.root, quarantineName, id, "access.jsonl"), "utf8")).toBe("replacement")
    } finally {
      await fixture.cleanup()
    }
  })

  test("keeps a quarantine at grace-1 and removes it at the grace boundary", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "quarantine-grace")
      const directory = join(fixture.root, quarantineName, id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, "access.jsonl"), "old")
      await writeFile(
        join(directory, metadataName),
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )

      const beforeGrace = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: quarantineGraceMs - 1,
      })

      expect(beforeGrace).toEqual({ success: true, data: true })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect(await readFile(join(directory, "access.jsonl"), "utf8")).toBe("old")

      const atGrace = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: quarantineGraceMs,
      })

      expect(atGrace).toEqual({ success: true, data: true })
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fixture.cleanup()
    }
  })

  test("drains an old writer descriptor without touching a fresh reactivated live directory", async () => {
    const fixture = await fixtureCreate()
    let oldWriter: Awaited<ReturnType<typeof open>> | undefined
    try {
      const id = projectId("alice", "writer-drain")
      const oldDirectory = await projectDirectoryCreate(fixture.root, id)
      await writeFile(join(oldDirectory, "access.jsonl"), "old")
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const quarantineAt = retentionMs + 1
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: quarantineAt })

      const quarantinedLog = join(fixture.root, quarantineName, id, "access.jsonl")
      oldWriter = await open(quarantinedLog, "a")
      const freshDirectory = await projectDirectoryCreate(fixture.root, id)
      await writeFile(join(freshDirectory, "access.jsonl"), "fresh")

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [id],
        now: quarantineAt + quarantineGraceMs,
      })

      expect(result).toEqual({ success: true, data: true })
      await expect(lstat(join(fixture.root, quarantineName, id))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readFile(join(freshDirectory, "access.jsonl"), "utf8")).toBe("fresh")
      expect(await readFile(join(freshDirectory, metadataName), "utf8")).toBe('{"version":1,"state":"active"}')
      await oldWriter.write("drained")
    } finally {
      await oldWriter?.close()
      await fixture.cleanup()
    }
  })

  test("cleans a safe old collision before quarantining the newly expired same-ID generation", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "quarantine-replacement")
      const oldDirectory = join(fixture.root, quarantineName, id)
      await mkdir(oldDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(oldDirectory, "access.jsonl"), "old")
      await writeFile(
        join(oldDirectory, metadataName),
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )
      const liveDirectory = await projectDirectoryCreate(fixture.root, id)
      await writeFile(join(liveDirectory, "access.jsonl"), "new")
      await writeFile(join(liveDirectory, metadataName), '{"version":1,"state":"inactive","inactiveAt":0}')

      const now = retentionMs + quarantineGraceMs + 1
      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now,
      })

      expect(result).toEqual({ success: true, data: true })
      await expect(lstat(liveDirectory)).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readFile(join(fixture.root, quarantineName, id, "access.jsonl"), "utf8")).toBe("new")
      expect(await readFile(join(fixture.root, quarantineName, id, metadataName), "utf8")).toBe(
        `{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":${now}}`,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("preserves a quarantine with nested or special children", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-quarantine-child-"))
    try {
      const nestedId = projectId("alice", "nested-quarantine")
      const nestedDirectory = join(fixture.root, quarantineName, nestedId)
      await mkdir(join(nestedDirectory, "nested"), { recursive: true, mode: 0o700 })
      await writeFile(join(nestedDirectory, "access.jsonl"), "nested")
      await writeFile(join(nestedDirectory, "nested", "keep"), "keep")
      await writeFile(join(nestedDirectory, "unexpected.txt"), "unexpected")
      await writeFile(
        join(nestedDirectory, metadataName),
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )

      const fifoId = projectId("alice", "fifo-quarantine")
      const fifoDirectory = join(fixture.root, quarantineName, fifoId)
      await mkdir(fifoDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(fifoDirectory, "access.jsonl"), "fifo")
      await writeFile(
        join(fifoDirectory, metadataName),
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )
      const fifo = join(fifoDirectory, "writer.fifo")
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)

      const linkId = projectId("alice", "linked-quarantine-child")
      const linkDirectory = join(fixture.root, quarantineName, linkId)
      const outsideLog = join(outside, "access.jsonl")
      await mkdir(linkDirectory, { recursive: true, mode: 0o700 })
      await writeFile(outsideLog, "outside")
      await symlink(outsideLog, join(linkDirectory, "access.jsonl"))
      await writeFile(
        join(linkDirectory, metadataName),
        '{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":0}',
      )

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: quarantineGraceMs,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(nestedDirectory)).isDirectory()).toBe(true)
      expect((await lstat(join(nestedDirectory, "nested"))).isDirectory()).toBe(true)
      expect(await readFile(join(nestedDirectory, "unexpected.txt"), "utf8")).toBe("unexpected")
      expect((await lstat(fifo)).isFIFO()).toBe(true)
      expect(await readFile(join(fifoDirectory, "access.jsonl"), "utf8")).toBe("fifo")
      expect((await lstat(join(linkDirectory, "access.jsonl"))).isSymbolicLink()).toBe(true)
      expect(await readFile(outsideLog, "utf8")).toBe("outside")
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("preserves future and malformed quarantine metadata", async () => {
    const fixture = await fixtureCreate()
    try {
      const futureId = projectId("alice", "future-quarantine")
      const futureDirectory = join(fixture.root, quarantineName, futureId)
      await mkdir(futureDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(futureDirectory, "access.jsonl"), "future")
      await writeFile(
        join(futureDirectory, metadataName),
        `{"version":1,"state":"quarantined","inactiveAt":0,"quarantinedAt":${quarantineGraceMs + 1}}`,
      )

      const malformedId = projectId("alice", "malformed-quarantine")
      const malformedDirectory = join(fixture.root, quarantineName, malformedId)
      await mkdir(malformedDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(malformedDirectory, "access.jsonl"), "malformed")
      await writeFile(join(malformedDirectory, metadataName), '{"version":1,"state":"quarantined"}')

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: quarantineGraceMs,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(futureDirectory)).isDirectory()).toBe(true)
      expect((await lstat(malformedDirectory)).isDirectory()).toBe(true)
      expect(await readFile(join(futureDirectory, "access.jsonl"), "utf8")).toBe("future")
      expect(await readFile(join(malformedDirectory, "access.jsonl"), "utf8")).toBe("malformed")
    } finally {
      await fixture.cleanup()
    }
  })

  test("replaces a symlinked metadata file without following it", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-retention-outside-"))
    try {
      const id = projectId("alice", "metadata-replace")
      const directory = await projectDirectoryCreate(fixture.root, id)
      const outsideMetadata = join(outside, metadataName)
      await writeFile(outsideMetadata, JSON.stringify({ version: 1, state: "inactive", inactiveAt: 0 }))
      await symlink(outsideMetadata, join(directory, metadataName))

      const result = await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [id], now: 100 })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(join(directory, metadataName))).isFile()).toBe(true)
      expect(await readFile(join(directory, metadataName), "utf8")).toBe('{"version":1,"state":"active"}')
      expect(await readFile(outsideMetadata, "utf8")).toBe('{"version":1,"state":"inactive","inactiveAt":0}')
    } finally {
      await fixture.cleanup()
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("keeps valid metadata intact when the atomic temporary write cannot start", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "metadata-write-failure")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [], now: 0 })
      const metadataBefore = await readFile(join(directory, metadataName), "utf8")
      await chmod(directory, 0o500)

      const result = await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [id], now: 100 })

      expect(result).toEqual({ success: true, data: true })
      expect(await readFile(join(directory, metadataName), "utf8")).toBe(metadataBefore)
      await chmod(directory, 0o700)
    } finally {
      await chmod(join(fixture.root, "projects", projectId("alice", "metadata-write-failure")), 0o700).catch(() => {})
      await fixture.cleanup()
    }
  })

  test("removes a validated crash-left metadata temporary file and fsyncs its namespace", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "crash-left-metadata")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await writeFile(join(directory, metadataTemporaryName), "", { mode: 0o600 })
      const filesystem = retentionFileSystemCreate()

      const result = await projectAccessLogRetentionReconcile({
        root: fixture.root,
        activeProjectIds: [],
        now: retentionMs + 1,
        filesystem: filesystem.filesystem,
      })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(directory)).isDirectory()).toBe(true)
      expect(await readFile(join(directory, metadataName), "utf8")).toBe(
        `{"version":1,"state":"inactive","inactiveAt":${retentionMs + 1}}`,
      )
      await expect(lstat(join(directory, metadataTemporaryName))).rejects.toMatchObject({ code: "ENOENT" })
      expect(filesystem.purposes).toContain("metadata-namespace")
    } finally {
      await fixture.cleanup()
    }
  })

  test("cleans an atomic temporary file when replacing metadata fails", async () => {
    const fixture = await fixtureCreate()
    try {
      const id = projectId("alice", "metadata-rename-failure")
      const directory = await projectDirectoryCreate(fixture.root, id)
      await mkdir(join(directory, metadataName))

      const result = await projectAccessLogRetentionReconcile({ root: fixture.root, activeProjectIds: [id], now: 100 })

      expect(result).toEqual({ success: true, data: true })
      expect((await lstat(join(directory, metadataName))).isDirectory()).toBe(true)
      const entries = await Array.fromAsync(
        new Bun.Glob(`${metadataName}.tmp-*`).scan({ cwd: directory, onlyFiles: false }),
      )
      expect(entries).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })
})
