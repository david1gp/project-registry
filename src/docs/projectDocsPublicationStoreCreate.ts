import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { createResult, createResultError } from "#result"
import type { ProjectDocsPublicationStore } from "./ProjectDocsPublicationStore.js"

function markdownLabel(path: string): string {
  return path
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;")
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" })
  await chmod(temporary, 0o644)
  await rename(temporary, path)
}

export function projectDocsPublicationStoreCreate(
  rootInput = "/var/lib/project-registry-docs",
): ProjectDocsPublicationStore {
  const root = resolve(rootInput)
  const directory = (owner: string): string => join(root, createHash("sha256").update(owner).digest("hex"))
  const pending = new Map<string, Promise<unknown>>()
  const publish: ProjectDocsPublicationStore["publish"] = async (owner, sourcePath, markdown) => {
    const op = "projectDocsPublish"
    if (!isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath || sourcePath.includes("\0")) {
      return createResultError(op, "sourcePath must be an absolute normalized filesystem path")
    }
    if (typeof markdown !== "string" || Buffer.byteLength(markdown, "utf8") > 1_048_576) {
      return createResultError(op, "markdown must be a string no larger than 1 MiB")
    }
    const ownerDirectory = directory(owner)
    const file = `${createHash("sha256").update(sourcePath).digest("hex")}.md`
    try {
      await mkdir(root, { recursive: true, mode: 0o755 })
      if (!(await lstat(root)).isDirectory()) throw new Error("publication storage root must be a real directory")
      await chmod(root, 0o755)
      await mkdir(ownerDirectory, { recursive: true, mode: 0o755 })
      if (!(await lstat(ownerDirectory)).isDirectory())
        throw new Error("owner publication storage must be a real directory")
      await chmod(ownerDirectory, 0o755)
      await writeAtomic(join(ownerDirectory, file), markdown)
      const index = "index.md"
      const names = await readdir(ownerDirectory)
      const entries = new Map<string, string>()
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        try {
          const value: unknown = JSON.parse(await readFile(join(ownerDirectory, name), "utf8"))
          if (
            typeof value === "object" &&
            value !== null &&
            "sourcePath" in value &&
            typeof value.sourcePath === "string" &&
            "file" in value &&
            value.file === `${createHash("sha256").update(value.sourcePath).digest("hex")}.md`
          ) {
            entries.set(value.sourcePath, value.file)
          }
        } catch {
          // Ignore corrupt metadata; publication writes a fresh record for this source.
        }
      }
      entries.set(sourcePath, file)
      const metadata = `${createHash("sha256").update(sourcePath).digest("hex")}.json`
      await writeAtomic(join(ownerDirectory, metadata), JSON.stringify({ sourcePath, file }))
      const indexContent = `${[...entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, name]) => `- [${markdownLabel(path)}](${name})`)
        .join("\n")}\n`
      await writeAtomic(join(ownerDirectory, index), indexContent)
      return createResult({ file, index })
    } catch (error) {
      return createResultError(
        op,
        error instanceof Error ? error.message : "publication storage failed",
        ownerDirectory,
      )
    }
  }
  return {
    directory,
    async publish(owner, sourcePath, markdown) {
      // Serialize each owner's metadata scan and index replacement so concurrent
      // publications cannot silently remove one another from the index.
      const previous = pending.get(owner)
      const current = (previous ?? Promise.resolve()).then(() => publish(owner, sourcePath, markdown))
      pending.set(owner, current)
      try {
        return await current
      } finally {
        if (pending.get(owner) === current) pending.delete(owner)
      }
    },
  }
}
