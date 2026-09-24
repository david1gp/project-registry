import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectDocsPublicationStoreCreate } from "./projectDocsPublicationStoreCreate.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

describe("projectDocsPublicationStoreCreate", () => {
  test("updates a stable file and indexes absolute source paths without exposing client paths as storage paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))

    const first = await store.publish("alice", "/home/alice/project/read me.md", "# Original")
    const second = await store.publish("alice", "/home/alice/project/read me.md", "# Updated")

    expect(first).toMatchObject({ success: true })
    expect(second).toMatchObject({ success: true })
    if (!first.success || !second.success) return
    expect(second.data.file).toBe(first.data.file)
    expect(await readFile(join(store.directory("alice"), second.data.file), "utf8")).toBe("# Updated")
    expect(await readFile(join(store.directory("alice"), "index.md"), "utf8")).toBe(
      `- [/home/alice/project/read me.md](${first.data.file})\n`,
    )
    expect(store.directory("alice")).not.toContain("/home/alice/project")
    expect(store.directory("alice")).not.toBe(store.directory("bob"))
    expect((await stat(join(root, "published"))).mode & 0o777).toBe(0o755)
    expect((await stat(store.directory("alice"))).mode & 0o777).toBe(0o755)
    expect((await stat(join(store.directory("alice"), second.data.file))).mode & 0o777).toBe(0o644)
    expect((await stat(join(store.directory("alice"), "index.md"))).mode & 0o777).toBe(0o644)
  })

  test("keeps all entries when publications for the same owner overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-concurrent-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const paths = Array.from({ length: 24 }, (_, index) => `/home/alice/${index}.md`)
    const results = await Promise.all(paths.map((path) => store.publish("alice", path, "# Content")))

    expect(results.every((result) => result.success)).toBe(true)
    const index = await readFile(join(store.directory("alice"), "index.md"), "utf8")
    for (const path of paths) expect(index).toContain(`[${path}]`)
    expect(index.trim().split("\n")).toHaveLength(paths.length)
  })

  test("escapes source paths in Markdown index labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-escaped-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const result = await store.publish("alice", "/home/alice/<img>&[x].md", "# Content")
    expect(result.success).toBe(true)
    const index = await readFile(join(store.directory("alice"), "index.md"), "utf8")
    expect(index).toContain("[/home/alice/&lt;img&gt;&amp;\\[x\\].md]")
    expect(index).not.toContain("<img>")
  })

  test("rejects non-absolute source paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-invalid-"))
    temporaryDirectories.push(root)
    const result = await projectDocsPublicationStoreCreate(join(root, "published")).publish(
      "alice",
      "notes.md",
      "# Nope",
    )
    expect(result).toMatchObject({
      success: false,
      errorMessage: "sourcePath must be an absolute normalized filesystem path",
    })
    const traversal = await projectDocsPublicationStoreCreate(join(root, "published")).publish(
      "alice",
      "/home/alice/../bob.md",
      "# Nope",
    )
    expect(traversal).toMatchObject({ success: false })
  })
})
