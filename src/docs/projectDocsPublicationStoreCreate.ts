import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { createResult, createResultError } from "#result"
import type { ProjectDocsPublicationStore } from "./ProjectDocsPublicationStore.js"
import { projectDocsPagePathIsValid } from "./projectDocsPagePathIsValid.js"

type PublicationEntry = { file: string; pagePath?: string; sourcePath: string }

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function markdownLabel(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
}

function markdownTitle(markdown: string, pagePath: string): string {
  const title = markdown.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1]
  return title?.trim() || basename(pagePath, ".md")
}

function markdownWithHomeLink(markdown: string): string {
  const homeLink = "[Documentation home](/docs/index.md)"
  const enriched = markdown.replace(/^\[Documentation home\]\(\/docs\/index\.md\)\r?\n(?:\r?\n)?/, "")
  return `${homeLink}\n\n${enriched}`
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" })
  await chmod(temporary, 0o644)
  await rename(temporary, path)
}

function indexGenerate(entries: PublicationEntry[], ownerDirectory: string): Promise<string> {
  return Promise.all(
    entries.map(async (entry) => {
      const content = await readFile(join(ownerDirectory, entry.file), "utf8").catch(() => "")
      const logicalPath = entry.pagePath ?? basename(entry.sourcePath)
      const title = markdownTitle(content, logicalPath)
      const link = entry.file.split(sep).map(encodeURIComponent).join("/")
      return { ...entry, logicalPath, link, title }
    }),
  ).then((documents) => {
    const legacy = documents.filter((entry) => entry.pagePath === undefined)
    const pages = documents.filter((entry) => entry.pagePath !== undefined)
    const output: string[] = []
    const byDirectory = new Map<string, typeof pages>()
    for (const page of pages) {
      const directory = dirname(page.pagePath!).replaceAll(sep, "/")
      const group = directory === "." ? "" : directory
      byDirectory.set(group, [...(byDirectory.get(group) ?? []), page])
    }
    for (const directory of [...byDirectory.keys()].sort((a, b) => a.localeCompare(b))) {
      if (directory) output.push(`## ${markdownLabel(directory)}`, "")
      for (const page of byDirectory.get(directory)!.sort((a, b) => a.pagePath!.localeCompare(b.pagePath!))) {
        output.push(`- [${markdownLabel(page.title)}](${page.link})`)
      }
      output.push("")
    }
    if (legacy.length > 0) {
      output.push("## Previously published", "")
      for (const page of legacy.sort((a, b) => a.file.localeCompare(b.file))) {
        output.push(`- [${markdownLabel(page.title)}](${page.link})`)
      }
      output.push("")
    }
    return `${output.join("\n").trimEnd()}\n`
  })
}

export function projectDocsPublicationStoreCreate(
  rootInput = "/var/lib/project-registry-docs",
): ProjectDocsPublicationStore {
  const root = resolve(rootInput)
  const directory = (owner: string): string => join(root, hash(owner))
  const pending = new Map<string, Promise<unknown>>()
  const publish: ProjectDocsPublicationStore["publish"] = async (owner, sourcePath, markdown, pagePath) => {
    const op = "projectDocsPublish"
    if (!isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath || sourcePath.includes("\0")) {
      return createResultError(op, "sourcePath must be an absolute normalized filesystem path")
    }
    if (pagePath !== undefined && !projectDocsPagePathIsValid(pagePath)) {
      return createResultError(op, "pagePath must be a safe relative Markdown path other than index.md")
    }
    if (typeof markdown !== "string" || Buffer.byteLength(markdown, "utf8") > 1_048_576) {
      return createResultError(op, "markdown must be a string no larger than 1 MiB")
    }
    const ownerDirectory = directory(owner)
    const file = pagePath ?? `${hash(sourcePath)}.md`
    const metadataName = pagePath === undefined ? `${hash(sourcePath)}.json` : `page-${hash(pagePath)}.json`
    try {
      await mkdir(root, { recursive: true, mode: 0o755 })
      if (!(await lstat(root)).isDirectory()) throw new Error("publication storage root must be a real directory")
      await chmod(root, 0o755)
      await mkdir(ownerDirectory, { recursive: true, mode: 0o755 })
      if (!(await lstat(ownerDirectory)).isDirectory())
        throw new Error("owner publication storage must be a real directory")
      await chmod(ownerDirectory, 0o755)
      const target = join(ownerDirectory, file)
      await mkdir(dirname(target), { recursive: true, mode: 0o755 })
      await writeAtomic(target, markdownWithHomeLink(markdown))
      const names = await readdir(ownerDirectory)
      const entries = new Map<string, PublicationEntry>()
      for (const name of names) {
        if (!/^(?:[a-f0-9]{64}|page-[a-f0-9]{64})\.json$/.test(name)) continue
        try {
          const value: unknown = JSON.parse(await readFile(join(ownerDirectory, name), "utf8"))
          if (
            typeof value !== "object" ||
            value === null ||
            !("sourcePath" in value) ||
            typeof value.sourcePath !== "string" ||
            !("file" in value) ||
            typeof value.file !== "string" ||
            !isAbsolute(value.sourcePath)
          )
            continue
          if ("pagePath" in value && projectDocsPagePathIsValid(value.pagePath)) {
            if (value.file === value.pagePath) entries.set(`page:${value.pagePath}`, value as PublicationEntry)
            continue
          }
          if (value.file === `${hash(value.sourcePath)}.md`) {
            entries.set(`legacy:${value.sourcePath}`, value as PublicationEntry)
          }
        } catch {
          // Ignore corrupt metadata; publication writes a fresh record for this identity.
        }
      }
      const entry: PublicationEntry = { sourcePath, file, ...(pagePath === undefined ? {} : { pagePath }) }
      entries.set(pagePath === undefined ? `legacy:${sourcePath}` : `page:${pagePath}`, entry)
      await writeAtomic(join(ownerDirectory, metadataName), JSON.stringify(entry))
      const index = "index.md"
      const indexContent = await indexGenerate([...entries.values()], ownerDirectory)
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
    async publish(owner, sourcePath, markdown, pagePath) {
      // Serialize each owner's metadata scan and index replacement so concurrent
      // publications cannot silently remove one another from the index.
      const previous = pending.get(owner)
      const current = (previous ?? Promise.resolve()).then(() => publish(owner, sourcePath, markdown, pagePath))
      pending.set(owner, current)
      try {
        return await current
      } finally {
        if (pending.get(owner) === current) pending.delete(owner)
      }
    },
  }
}
