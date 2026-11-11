import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { devLeaseActivityFilesystemDefault } from "./devLeaseActivityFilesystemDefault.js"

describe("devLeaseActivityFilesystemDefault", () => {
  test("returns undefined for a missing log file", async () => {
    const filesystem = devLeaseActivityFilesystemDefault()

    await expect(
      filesystem.readTail(join(tmpdir(), "project-registry-no-such-dev-log.jsonl"), 1024),
    ).resolves.toBeUndefined()
  })

  test("reads the whole file when it fits and only the tail when it does not", async () => {
    const directory = await mkdtemp(join(tmpdir(), "registry-dev-activity-"))
    try {
      const filesystem = devLeaseActivityFilesystemDefault()
      const path = join(directory, "access.jsonl")
      await writeFile(path, "0123456789")

      await expect(filesystem.readTail(path, 1024)).resolves.toEqual(new TextEncoder().encode("0123456789"))
      const tail = await filesystem.readTail(path, 4)
      expect(new TextDecoder().decode(tail)).toBe("6789")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
