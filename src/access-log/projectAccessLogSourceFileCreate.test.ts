import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { appendFile, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { gzipSync } from "node:zlib"
import { projectAccessLogPath } from "./projectAccessLogPath.js"
import { projectAccessLogSourceFileCreate } from "./projectAccessLogSourceFileCreate.js"

const project = { owner: "alice", name: "catalog" }

function rawRecord(timestamp: number, ip = "192.0.2.10"): string {
  return JSON.stringify({
    ts: timestamp,
    request: { method: "GET", host: "app.example", uri: `/path?secret=${timestamp}`, client_ip: ip },
    status: 200,
    duration: 0.01,
    size: timestamp,
  })
}

async function fixtureCreate(): Promise<{ root: string; active: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "project-registry-access-log-"))
  const activeR = projectAccessLogPath(root, project)
  if (!activeR.success) throw new Error(activeR.errorMessage)
  const directory = dirname(activeR.data)
  await mkdir(directory, { recursive: true })
  return { root, active: activeR.data, directory }
}

async function fifoCreate(path: string): Promise<void> {
  const process = Bun.spawn(["mkfifo", path])
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`mkfifo failed with exit code ${exitCode}`)
}

describe("projectAccessLogSourceFileCreate", () => {
  test("pages active JSONL and gzip archives newest-first", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(3)}\n${rawRecord(4)}\n`)
      await writeFile(
        join(fixture.directory, "access-20260820.jsonl.gz"),
        gzipSync(`${rawRecord(1)}\n${rawRecord(2)}\n`),
      )
      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return

      const firstR = await sourceR.data.read(project, { limit: 2 })
      expect(firstR.success).toBe(true)
      if (!firstR.success) return
      expect(firstR.data.records.map((record) => record.timestamp)).toEqual([4, 3])
      expect(firstR.data.next).toBeDefined()

      const secondR = await sourceR.data.read(project, { limit: 2, before: firstR.data.next })
      expect(secondR.success).toBe(true)
      if (!secondR.success) return
      expect(secondR.data.records.map((record) => record.timestamp)).toEqual([2, 1])
      expect(secondR.data.next).toBeUndefined()
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("reads a transitional plain archive once while gzip is produced", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(4)}\n`)
      const transitional = join(fixture.directory, "access-20260821.jsonl")
      const transitionalContent = `${rawRecord(2)}\n${rawRecord(3)}\n`
      await writeFile(transitional, transitionalContent)
      await writeFile(`${transitional}.gz`, gzipSync(transitionalContent))
      await writeFile(join(fixture.directory, "access-20260820.jsonl.gz"), gzipSync(`${rawRecord(1)}\n`))

      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return

      const firstR = await sourceR.data.read(project, { limit: 2 })
      expect(firstR.success).toBe(true)
      if (!firstR.success || firstR.data.next === undefined) return
      expect(firstR.data.records.map((record) => record.timestamp)).toEqual([4, 3])

      const secondR = await sourceR.data.read(project, { limit: 2, before: firstR.data.next })
      expect(secondR.success).toBe(true)
      if (secondR.success) {
        expect(secondR.data.records.map((record) => record.timestamp)).toEqual([2, 1])
        expect(secondR.data.next).toBeUndefined()
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("orders roll filenames by stable bytes and prefers plain transitional archives", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(4)}\n`)
      await writeFile(join(fixture.directory, "access-20260821_120000.jsonl"), `${rawRecord(2)}\n`)
      const transitional = join(fixture.directory, "access-20260821.jsonl")
      await writeFile(transitional, `${rawRecord(1)}\n`)
      await writeFile(`${transitional}.gz`, gzipSync(`${rawRecord(99)}\n`))
      await writeFile(join(fixture.directory, "access-20260821-120000.jsonl"), `${rawRecord(3)}\n`)

      const sourceR = projectAccessLogSourceFileCreate(fixture.root)
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return

      const pageR = await sourceR.data.read(project, { limit: 10 })
      expect(pageR).toMatchObject({ success: true })
      if (pageR.success) {
        expect(pageR.data.records.map((record) => record.timestamp)).toEqual([4, 2, 1, 3])
        expect(pageR.data.next).toBeUndefined()
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("returns a rotation race when a listed transitional archive disappears", async () => {
    const fixture = await fixtureCreate()
    try {
      const archivePath = join(fixture.directory, "access-20260821.jsonl")
      const noise = randomBytes(8 * 1024 * 1024)
      for (let index = 1_023; index < noise.length; index += 1_024) noise[index] = 0x0a
      const content = Buffer.concat([noise, Buffer.from(`${rawRecord(1)}\n`)])
      await writeFile(`${archivePath}.gz`, gzipSync(content, { level: 0 }))
      await writeFile(archivePath, content)
      const sourceR = projectAccessLogSourceFileCreate(fixture.root)
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return

      const readPromise = sourceR.data.read(project, { limit: 1 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await rm(archivePath)
      expect(await readPromise).toMatchObject({ success: false, code: "access-log.rotation-race" })
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("skips malformed lines while reporting a partial page", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(1)}\nnot-json\n${rawRecord(2)}\n`)
      const sourceR = projectAccessLogSourceFileCreate(fixture.root)
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return
      const pageR = await sourceR.data.read(project)
      expect(pageR).toMatchObject({ success: true })
      if (pageR.success) {
        expect(pageR.data.records.map((record) => record.timestamp)).toEqual([2, 1])
        expect(pageR.data).toMatchObject({ partial: true, malformedLines: 1 })
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("keeps an active cursor valid after appending records", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(1)}\n${rawRecord(2)}\n`)
      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return

      const firstR = await sourceR.data.read(project, { limit: 1 })
      expect(firstR.success).toBe(true)
      if (!firstR.success || firstR.data.next === undefined) return
      await appendFile(fixture.active, `${rawRecord(3)}\n`)

      const secondR = await sourceR.data.read(project, { limit: 1, before: firstR.data.next })
      expect(secondR).toMatchObject({ success: true })
      if (secondR.success) {
        expect(secondR.data.records.map((record) => record.timestamp)).toEqual([1])
        expect(secondR.data.next).toBeUndefined()
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("uses the signed digest and absolute offset rather than timestamps for duplicates", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(1, "192.0.2.10")}\n${rawRecord(1, "198.51.100.10")}\n`)
      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return

      const firstR = await sourceR.data.read(project, { limit: 1 })
      expect(firstR.success).toBe(true)
      if (!firstR.success || firstR.data.next === undefined) return
      const secondR = await sourceR.data.read(project, { limit: 1, before: firstR.data.next })
      expect(secondR).toMatchObject({ success: true })
      if (secondR.success) expect(secondR.data.records.map((record) => record.clientNetwork)).toEqual(["192.0.2.0/24"])
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("enforces line, scan, and decompressed-byte limits", async () => {
    const fixture = await fixtureCreate()
    try {
      const content = `${rawRecord(1)}\n`
      await writeFile(fixture.active, content)
      const lineLimitedR = projectAccessLogSourceFileCreate({
        root: fixture.root,
        limits: { maxLineBytes: content.length - 2 },
      })
      expect(lineLimitedR.success).toBe(true)
      if (lineLimitedR.success) {
        expect(await lineLimitedR.data.read(project)).toMatchObject({
          success: false,
          code: "access-log.resource-limit",
        })
      }

      const archivePath = join(fixture.directory, "access-20260820.jsonl.gz")
      await writeFile(archivePath, gzipSync(`${rawRecord(2)}\n`))
      const compressedR = projectAccessLogSourceFileCreate({
        root: fixture.root,
        limits: { maxDecompressedBytes: 1 },
      })
      expect(compressedR.success).toBe(true)
      if (compressedR.success) {
        expect(await compressedR.data.read(project)).toMatchObject({
          success: false,
          code: "access-log.resource-limit",
        })
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("caps a large directory of invalid entries before archive discovery grows", async () => {
    const fixture = await fixtureCreate()
    try {
      for (let index = 0; index < 32; index += 1) {
        await writeFile(join(fixture.directory, `unrelated-${index}.entry`), "not an access log")
      }
      const sourceR = projectAccessLogSourceFileCreate(fixture.root)
      expect(sourceR.success).toBe(true)
      if (sourceR.success) {
        expect(await sourceR.data.read(project)).toMatchObject({
          success: false,
          code: "access-log.resource-limit",
        })
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("caps valid archives at the configured Caddy retention", async () => {
    const fixture = await fixtureCreate()
    try {
      for (let index = 0; index < 9; index += 1) {
        await writeFile(join(fixture.directory, `access-202608${String(21 - index).padStart(2, "0")}.jsonl`), "")
      }
      const sourceR = projectAccessLogSourceFileCreate(fixture.root)
      expect(sourceR.success).toBe(true)
      if (sourceR.success) {
        expect(await sourceR.data.read(project)).toMatchObject({
          success: false,
          code: "access-log.resource-limit",
        })
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("returns a decompressed resource limit when a prior archive exhausts the budget", async () => {
    const fixture = await fixtureCreate()
    try {
      const content = Buffer.from(`${rawRecord(2)}\n`)
      await writeFile(join(fixture.directory, "access-20260821.jsonl.gz"), gzipSync(content))
      await writeFile(join(fixture.directory, "access-20260820.jsonl.gz"), gzipSync(Buffer.alloc(0)))
      const sourceR = projectAccessLogSourceFileCreate({
        root: fixture.root,
        limits: { maxRecords: 2, maxDecompressedBytes: content.length },
      })
      expect(sourceR.success).toBe(true)
      if (sourceR.success) {
        expect(await sourceR.data.read(project, { limit: 2 })).toMatchObject({
          success: false,
          code: "access-log.resource-limit",
          errorMessage: "access log decompressed-byte limit exceeded",
        })
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("reads a large active file from the end for a limit-one page", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${"old\n".repeat(256 * 1024)}${rawRecord(1)}\n${rawRecord(2)}\n`)
      const sourceR = projectAccessLogSourceFileCreate({
        root: fixture.root,
        limits: { maxScannedBytes: 64 * 1024 },
        cursorSecret: "test-secret",
      })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return
      const pageR = await sourceR.data.read(project, { limit: 1 })
      expect(pageR).toMatchObject({ success: true })
      if (pageR.success) {
        expect(pageR.data.records.map((record) => record.timestamp)).toEqual([2])
        expect(pageR.data.next).toBeDefined()
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("does not scan a newline-heavy prefix for a limit-one page", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${"\n".repeat(512 * 1024)}${rawRecord(1)}\n${rawRecord(2)}\n`)
      const sourceR = projectAccessLogSourceFileCreate({
        root: fixture.root,
        limits: { maxScannedBytes: 64 * 1024 },
      })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return
      const pageR = await sourceR.data.read(project, { limit: 1 })
      expect(pageR).toMatchObject({ success: true })
      if (pageR.success) expect(pageR.data.records.map((record) => record.timestamp)).toEqual([2])
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("continues gzip pagination before the cursor without retaining the archive", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(
        join(fixture.directory, "access-20260820.jsonl.gz"),
        gzipSync(`${rawRecord(1)}\n${rawRecord(2)}\n${rawRecord(3)}\n`),
      )
      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return

      const firstR = await sourceR.data.read(project, { limit: 1 })
      expect(firstR.success).toBe(true)
      if (!firstR.success || firstR.data.next === undefined) return
      expect(firstR.data.records.map((record) => record.timestamp)).toEqual([3])

      const secondR = await sourceR.data.read(project, { limit: 1, before: firstR.data.next })
      expect(secondR.success).toBe(true)
      if (!secondR.success || secondR.data.next === undefined) return
      expect(secondR.data.records.map((record) => record.timestamp)).toEqual([2])

      const thirdR = await sourceR.data.read(project, { limit: 1, before: secondR.data.next })
      expect(thirdR.success).toBe(true)
      if (thirdR.success) {
        expect(thirdR.data.records.map((record) => record.timestamp)).toEqual([1])
        expect(thirdR.data.next).toBeUndefined()
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("rejects a symlinked project directory", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-access-log-outside-"))
    try {
      await writeFile(join(outside, "access.jsonl"), rawRecord(99))
      await rm(fixture.directory, { recursive: true })
      await symlink(outside, fixture.directory)

      const sourceR = projectAccessLogSourceFileCreate(fixture.root)
      expect(sourceR.success).toBe(true)
      if (sourceR.success) {
        expect(await sourceR.data.read(project)).toMatchObject({ success: false, code: "access-log.symlink" })
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("rejects a symlinked projects directory", async () => {
    const fixture = await fixtureCreate()
    const outside = await mkdtemp(join(tmpdir(), "project-registry-access-log-outside-"))
    try {
      const outsideProject = join(outside, basename(fixture.directory))
      await mkdir(outsideProject, { recursive: true })
      await writeFile(join(outsideProject, "access.jsonl"), rawRecord(99))
      const projectsDirectory = dirname(fixture.directory)
      await rm(projectsDirectory, { recursive: true })
      await symlink(outside, projectsDirectory)

      const sourceR = projectAccessLogSourceFileCreate(fixture.root)
      expect(sourceR.success).toBe(true)
      if (sourceR.success) {
        expect(await sourceR.data.read(project)).toMatchObject({ success: false, code: "access-log.symlink" })
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
      await rm(outside, { force: true, recursive: true })
    }
  })

  test("rejects active and archive FIFOs without blocking", async () => {
    for (const file of [{ name: "access.jsonl" }, { name: "access-20260821.jsonl" }]) {
      const fixture = await fixtureCreate()
      try {
        await fifoCreate(join(fixture.directory, file.name))
        const sourceR = projectAccessLogSourceFileCreate(fixture.root)
        expect(sourceR.success).toBe(true)
        if (sourceR.success) {
          expect(await sourceR.data.read(project)).toMatchObject({
            success: false,
            code: "access-log.non-regular-file",
          })
        }
      } finally {
        await rm(fixture.root, { force: true, recursive: true })
      }
    }
  })

  test("rejects symlinks and expires a cursor after active rotation", async () => {
    const fixture = await fixtureCreate()
    const outside = join(fixture.root, "outside.jsonl")
    try {
      await writeFile(outside, rawRecord(1))
      await symlink(outside, fixture.active)
      const symlinkR = projectAccessLogSourceFileCreate(fixture.root)
      expect(symlinkR.success).toBe(true)
      if (symlinkR.success)
        expect(await symlinkR.data.read(project)).toMatchObject({ success: false, code: "access-log.symlink" })

      await rm(fixture.active)
      await mkdir(fixture.active)
      const directoryR = projectAccessLogSourceFileCreate(fixture.root)
      expect(directoryR.success).toBe(true)
      if (directoryR.success) {
        expect(await directoryR.data.read(project)).toMatchObject({
          success: false,
          code: "access-log.non-regular-file",
        })
      }
      await rm(fixture.active, { recursive: true })
      await writeFile(fixture.active, `${rawRecord(2)}\n${rawRecord(1)}\n`)
      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return
      const pageR = await sourceR.data.read(project, { limit: 1 })
      expect(pageR.success).toBe(true)
      if (!pageR.success || pageR.data.next === undefined) return
      const rotated = join(fixture.directory, "access-20260821.jsonl")
      await rename(fixture.active, rotated)
      await writeFile(fixture.active, `${rawRecord(3)}\n`)
      const expiredR = await sourceR.data.read(project, { before: pageR.data.next })
      expect(expiredR).toMatchObject({ success: false, code: "access-log.cursor-expired" })
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("expires a cursor when the active file is rewritten in place", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(1)}\n${rawRecord(2)}\n`)
      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return
      const pageR = await sourceR.data.read(project, { limit: 1 })
      expect(pageR.success).toBe(true)
      if (!pageR.success || pageR.data.next === undefined) return

      const beforeStat = await lstat(fixture.active)
      await writeFile(fixture.active, `${rawRecord(3)}\n${rawRecord(4)}\n`)
      const afterStat = await lstat(fixture.active)
      expect(afterStat.dev).toBe(beforeStat.dev)
      expect(afterStat.ino).toBe(beforeStat.ino)
      expect(afterStat.birthtimeMs).toBe(beforeStat.birthtimeMs)

      expect(await sourceR.data.read(project, { before: pageR.data.next })).toMatchObject({
        success: false,
        code: "access-log.cursor-expired",
      })
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  test("expires a cursor when the active file is truncated in place", async () => {
    const fixture = await fixtureCreate()
    try {
      await writeFile(fixture.active, `${rawRecord(1)}\n${rawRecord(2)}\n`)
      const sourceR = projectAccessLogSourceFileCreate({ root: fixture.root, cursorSecret: "test-secret" })
      expect(sourceR.success).toBe(true)
      if (!sourceR.success) return
      const pageR = await sourceR.data.read(project, { limit: 1 })
      expect(pageR.success).toBe(true)
      if (!pageR.success || pageR.data.next === undefined) return

      const beforeStat = await lstat(fixture.active)
      await writeFile(fixture.active, `${rawRecord(1)}\n`)
      const afterStat = await lstat(fixture.active)
      expect(afterStat.dev).toBe(beforeStat.dev)
      expect(afterStat.ino).toBe(beforeStat.ino)
      expect(afterStat.birthtimeMs).toBe(beforeStat.birthtimeMs)

      expect(await sourceR.data.read(project, { before: pageR.data.next })).toMatchObject({
        success: false,
        code: "access-log.cursor-expired",
      })
    } finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })
})
