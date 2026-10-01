import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { hostsManagedBlockReconcile } from "./hostsManagedBlockReconcile.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("hostsManagedBlockReconcile", () => {
  test("preserves unmanaged content, supports add/remove, and is idempotent with mode 0644", async () => {
    const directory = await mkdtemp(join(tmpdir(), "registry-hosts-"))
    tempDirs.push(directory)
    const path = join(directory, "hosts")
    await writeFile(path, "127.0.0.1 localhost\n# user entry\n")

    expect((await hostsManagedBlockReconcile(path, ["b.dev", "A.dev"])).success).toBe(true)
    const first = await readFile(path, "utf8")
    expect(first).toContain("127.0.0.1 localhost\n# user entry\n\n# BEGIN")
    expect(first).toContain("127.0.0.1 a.dev\n127.0.0.1 b.dev")
    expect((await stat(path)).mode & 0o777).toBe(0o644)

    expect((await hostsManagedBlockReconcile(path, ["a.dev", "b.dev"])).success).toBe(true)
    expect(await readFile(path, "utf8")).toBe(first)
    expect((await hostsManagedBlockReconcile(path, ["b.dev"])).success).toBe(true)
    expect(await readFile(path, "utf8")).not.toContain("127.0.0.1 a.dev")
    expect(await readFile(path, "utf8")).toContain("# user entry")
  })

  test("rejects malformed existing managed markers without changing the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "registry-hosts-"))
    tempDirs.push(directory)
    const path = join(directory, "hosts")
    const contents = "# BEGIN project-registry managed hosts\nuntouched\n"
    await writeFile(path, contents)
    expect((await hostsManagedBlockReconcile(path, ["valid.dev"])).success).toBe(false)
    expect(await readFile(path, "utf8")).toBe(contents)
  })
})
