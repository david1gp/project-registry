import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
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
  test("keeps legacy source-hash storage and indexes a readable title without exposing source paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))

    const first = await store.publish("alice", "/home/alice/project/read me.md", "# Original")
    const second = await store.publish("alice", "/home/alice/project/read me.md", "# Updated")

    expect(first).toMatchObject({ success: true })
    expect(second).toMatchObject({ success: true })
    if (!first.success || !second.success) return
    expect(second.data.file).toBe(first.data.file)
    expect(await readFile(join(store.directory("alice"), second.data.file), "utf8")).toBe(
      "[Documentation home](/docs/index.md)\n\n# Updated",
    )
    expect(await readFile(join(store.directory("alice"), "index.md"), "utf8")).toBe(
      `## Previously published\n\n- [Updated](${first.data.file})\n`,
    )
    expect(await readFile(join(store.directory("alice"), `${first.data.file.slice(0, 64)}.json`), "utf8")).toContain(
      "/home/alice/project/read me.md",
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
    expect(index.match(/^- \[/gm)).toHaveLength(paths.length)
  })

  test("escapes legacy titles in Markdown index labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-escaped-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const result = await store.publish("alice", "/home/alice/<img>&[x].md", "# <img>&[x]")
    expect(result.success).toBe(true)
    const index = await readFile(join(store.directory("alice"), "index.md"), "utf8")
    expect(index).toContain("[&lt;img&gt;&amp;\\[x\\]]")
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

  test("uses logical page paths as owner-scoped identity and groups titles by hierarchy", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-pages-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))

    const first = await store.publish("alice", "/work/first.md", "# First title", "guides/setup.md")
    const updated = await store.publish("alice", "/elsewhere/setup.md", "# Updated setup", "guides/setup.md")
    const otherOwner = await store.publish("bob", "/elsewhere/setup.md", "# Bob", "guides/setup.md")

    expect(first).toMatchObject({ success: true, data: { file: "guides/setup.md" } })
    expect(updated).toMatchObject({ success: true, data: { file: "guides/setup.md" } })
    expect(otherOwner).toMatchObject({ success: true, data: { file: "guides/setup.md" } })
    expect(await readFile(join(store.directory("alice"), "guides/setup.md"), "utf8")).toBe(
      "[Documentation home](/docs/index.md)\n\n# Updated setup",
    )
    const index = await readFile(join(store.directory("alice"), "index.md"), "utf8")
    expect(index).toContain("## guides\n\n- [Updated setup](guides/setup.md)")
    expect(index).not.toContain("/elsewhere/setup.md")
    const files = await readdir(store.directory("alice"))
    const metadata = await readFile(
      join(store.directory("alice"), files.find((name) => name.startsWith("page-"))!),
      "utf8",
    )
    expect(metadata).toContain('"sourcePath":"/elsewhere/setup.md"')
  })

  test("adds the canonical documentation-home link without retargeting nested relative links", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-home-link-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))

    await store.publish("alice", "/work/root.md", "# Root", "root.md")
    await store.publish("alice", "/work/nested.md", "[Documentation home](../index.md)\n\n# Nested", "guides/nested.md")

    const ownerDirectory = store.directory("alice")
    const rootPage = await readFile(join(ownerDirectory, "root.md"), "utf8")
    const nestedPage = await readFile(join(ownerDirectory, "guides/nested.md"), "utf8")
    expect(rootPage).toBe("[Documentation home](/docs/index.md)\n\n# Root")
    expect(nestedPage).toBe("[Documentation home](/docs/index.md)\n\n[Documentation home](../index.md)\n\n# Nested")
    expect(rootPage.match(/\[Documentation home\]/g)).toHaveLength(1)
    expect(nestedPage.match(/\[Documentation home\]/g)).toHaveLength(2)
    expect(await readFile(join(ownerDirectory, "index.md"), "utf8")).toContain("[Root](root.md)")
  })

  test("leaves legacy stored content intact until republished, then adds the home link", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-legacy-home-link-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const sourcePath = "/work/legacy.md"
    const initial = await store.publish("alice", sourcePath, "# Legacy")
    expect(initial.success).toBe(true)
    if (!initial.success) return

    const filePath = join(store.directory("alice"), initial.data.file)
    await Bun.write(filePath, "# Existing legacy content")
    expect(await readFile(filePath, "utf8")).toBe("# Existing legacy content")

    const republished = await store.publish("alice", sourcePath, "# Republished")

    expect(republished).toMatchObject({ success: true, data: { file: initial.data.file } })
    expect(await readFile(filePath, "utf8")).toBe("[Documentation home](/docs/index.md)\n\n# Republished")
  })

  test("retains old-format metadata and files while adding a new logical publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-old-metadata-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const ownerDirectory = store.directory("alice")
    await mkdir(ownerDirectory, { recursive: true })

    const sourcePath = "/legacy/project/guide.md"
    const file = `${createHash("sha256").update(sourcePath).digest("hex")}.md`
    const metadata = `${createHash("sha256").update(sourcePath).digest("hex")}.json`
    const oldContent = "# Old published guide\n\nKeep these bytes.\n"
    await writeFile(join(ownerDirectory, file), oldContent)
    await writeFile(join(ownerDirectory, metadata), JSON.stringify({ sourcePath, file }))

    const result = await store.publish("alice", "/new/project/start.md", "# New page", "guides/start.md")

    expect(result.success).toBe(true)
    expect(await readFile(join(ownerDirectory, file), "utf8")).toBe(oldContent)
    expect(await readFile(join(ownerDirectory, metadata), "utf8")).toBe(JSON.stringify({ sourcePath, file }))
    expect(await readFile(join(ownerDirectory, "index.md"), "utf8")).toContain(`- [Old published guide](${file})`)
    expect(await readFile(join(ownerDirectory, "index.md"), "utf8")).toContain("- [New page](guides/start.md)")
  })

  test("preserves home-link examples in authored content and injects only one leading link", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-home-example-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const authored =
      "# Example\n\n```md\n[Documentation home](/docs/index.md)\n```\n\n[Documentation home](/docs/index.md)"

    await store.publish("alice", "/work/example.md", authored, "guides/example.md")
    const expected = `[Documentation home](/docs/index.md)\n\n${authored}`
    expect(await readFile(join(store.directory("alice"), "guides/example.md"), "utf8")).toBe(expected)

    await store.publish("alice", "/elsewhere/example.md", expected, "guides/example.md")
    expect(await readFile(join(store.directory("alice"), "guides/example.md"), "utf8")).toBe(expected)
  })

  test("keeps a leading relative home link beneath the injected canonical link and preserves fenced examples", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-relative-home-link-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const authored = "[Documentation home](index.md)\n\n# Guide\n\n```md\n[Documentation home](index.md)\n```"

    await store.publish("alice", "/work/guide.md", authored, "guides/page.md")

    expect(await readFile(join(store.directory("alice"), "guides/page.md"), "utf8")).toBe(
      `[Documentation home](/docs/index.md)\n\n${authored}`,
    )
  })

  test("keeps concurrent logical-path updates and distinct entries in the index", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-logical-concurrent-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const results = await Promise.all([
      store.publish("alice", "/first/same.md", "# First", "guides/same.md"),
      store.publish("alice", "/second/same.md", "# Second", "guides/same.md"),
      store.publish("alice", "/other/unique.md", "# Unique", "reference/unique.md"),
    ])

    expect(results.every((result) => result.success)).toBe(true)
    const ownerDirectory = store.directory("alice")
    const index = await readFile(join(ownerDirectory, "index.md"), "utf8")
    expect(index.match(/\]\(guides\/same\.md\)/g)).toHaveLength(1)
    expect(index).toContain("[Unique](reference/unique.md)")
    const page = await readFile(join(ownerDirectory, "guides/same.md"), "utf8")
    expect(["# First", "# Second"].some((title) => page.endsWith(title))).toBe(true)
  })

  test("rejects traversal, non-Markdown paths, and the reserved generated index", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-registry-docs-paths-"))
    temporaryDirectories.push(root)
    const store = projectDocsPublicationStoreCreate(join(root, "published"))
    const hash = "a".repeat(64)
    for (const pagePath of [
      "../escape.md",
      "nested/../../escape.md",
      "/absolute.md",
      "index.md",
      "INDEX.MD/child.md",
      `${hash}.md/child.md`,
      `${hash}.json/child.md`,
      `page-${hash}.json/child.md`,
      "folder\\page.md",
      "notes.txt",
      "_draft.md",
      ".hidden/page.md",
      "notes..md",
    ]) {
      const result = await store.publish("alice", "/work/source.md", "# Invalid", pagePath)
      expect(result).toMatchObject({ success: false })
    }
    expect(await readFile(join(store.directory("alice"), "index.md"), "utf8").catch(() => "")).toBe("")
  })
})
