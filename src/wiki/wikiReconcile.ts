import { YAML } from "bun"
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile, chown } from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectCanonicalSchema, type ProjectCanonical } from "../project/projectCanonicalSchema.js"
import { wikiProjectFrontmatterBuild } from "./wikiProjectFrontmatter.js"
import { wikiProjectNameNormalize } from "./wikiProjectNameNormalize.js"
import { wikiProjectResolve, type WikiProjectEntry } from "./wikiProjectResolve.js"

export type WikiReconcileLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export type WikiReconcileSnapshot = {
  projects: readonly unknown[]
}

export type WikiReconcileInput = {
  root: string
  owner?: string
  projects?: readonly unknown[]
  snapshot?: WikiReconcileSnapshot | readonly unknown[]
  logger?: WikiReconcileLogger
}

export type WikiReconcileSummary = {
  processed: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  skippedMessages: string[]
}

const wikiReconcileRefreshKeys = [
  "displayName",
  "section",
  "customerName",
  "customerEmail",
  "previewUrl",
  "previewPort",
  "productionUrl",
  "productionAssetsUrl",
  "serviceDomains",
]

function wikiReconcileLog(logger: WikiReconcileLogger | undefined, level: "info" | "warn", message: string): void {
  if (level === "warn") {
    if (logger?.warn) logger.warn(message)
    else console.warn(message)
    return
  }
  if (logger?.info) logger.info(message)
}

function wikiReconcileSegmentSafe(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false
  if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return false
  return true
}

function wikiReconcileUnwrap(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  if (typeof record.schemaVersion === "number") return input
  if (record.project && typeof record.project === "object" && !Array.isArray(record.project)) return record.project
  return input
}

function wikiNoteStripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function wikiNoteSplit(content: string): { frontmatterText: string | null; body: string } {
  const text = wikiNoteStripBom(content)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { frontmatterText: null, body: text }
  return { frontmatterText: match[1]!, body: text.slice(match[0].length) }
}

function wikiFrontmatterParse(text: string): Record<string, unknown> | null {
  const source = wikiNoteStripBom(text)
  if (source.trim() === "") return {}
  try {
    const parsed: unknown = YAML.parse(source)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function wikiNoteFrontmatterMerge(
  existing: Record<string, unknown>,
  project: ProjectCanonical,
): Record<string, unknown> {
  const managed = wikiProjectFrontmatterBuild(project)
  const merged: Record<string, unknown> = { ...existing }
  for (const key of wikiReconcileRefreshKeys) {
    if (!(key in managed)) delete merged[key]
  }
  for (const [key, value] of Object.entries(managed)) merged[key] = value
  return merged
}

function wikiNoteSerialize(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(frontmatter, null, 2)
  const block = yaml.endsWith("\n") ? yaml : `${yaml}\n`
  return `---\n${block}---\n${body}`
}

const wikiAncillaryManagedKeys = ["projectRegistry", "owner", "name", ...wikiReconcileRefreshKeys]

function wikiAncillaryIdentityMatches(project: ProjectCanonical, frontmatter: Record<string, unknown>): boolean {
  const registry = frontmatter.projectRegistry
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return false
  const record = registry as Record<string, unknown>
  return record.owner === project.owner && record.name === project.name
}

function wikiAncillaryStripManaged(existing: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...existing }
  for (const key of wikiAncillaryManagedKeys) delete cleaned[key]
  return cleaned
}

async function wikiReconcileChownNew(
  path: string,
  uid: number,
  gid: number,
  logger: WikiReconcileLogger | undefined,
  label: string,
): Promise<void> {
  try {
    await chown(path, uid, gid)
  } catch (error) {
    // Best effort: temp-dir runs and non-root daemons cannot chown, but the
    // failure must stay visible so ownership drift is observable.
    wikiReconcileLog(logger, "warn", `wiki: cannot set ownership for ${label} at ${path}: ${(error as Error).message}`)
  }
}

async function wikiReconcileEnsureDir(
  path: string,
  uid: number,
  gid: number,
  logger: WikiReconcileLogger | undefined,
  label: string,
): Promise<boolean> {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory()) return false
    return false
  } catch {
    // Missing: create below.
  }
  await mkdir(path, { recursive: true })
  await wikiReconcileChownNew(path, uid, gid, logger, label)
  return true
}

async function wikiReconcilePathInsideTree(root: string, target: string): Promise<boolean> {
  const resolved = resolve(target)
  if (resolved !== root && !resolved.startsWith(root + sep)) return false
  let current = resolved
  while (current !== root && current.startsWith(root + sep)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) return false
    } catch {
      // Missing path segments cannot be symlinks; continue with the parent.
    }
    const parent = resolve(join(current, ".."))
    if (parent === current) break
    current = parent
  }
  return true
}

async function wikiReconcileScan(
  root: string,
  logger: WikiReconcileLogger | undefined,
): Promise<{ entries: WikiProjectEntry[]; unsafeFolderNorms: Set<string> }> {
  const entries: WikiProjectEntry[] = []
  const unsafeFolderNorms = new Set<string>()
  // Bounded scan roots: active Externe/Interne locations plus the immediate
  // children of the explicit Externe/Archiv container (no deep recursion into
  // nested project data). Archive hits keep their nested location on reuse.
  const scanBases: { parent: "Externe" | "Interne"; base: string; skipNames?: Set<string> }[] = [
    { parent: "Externe", base: join(root, "Projekte", "Externe"), skipNames: new Set(["Archiv"]) },
    { parent: "Interne", base: join(root, "Projekte", "Interne") },
    { parent: "Externe", base: join(root, "Projekte", "Externe", "Archiv") },
  ]
  for (const { parent, base, skipNames } of scanBases) {
    let dirents
    try {
      dirents = await readdir(base, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        wikiReconcileLog(logger, "warn", `wiki: skipping unreadable parent ${base}: ${(error as Error).message}`)
      }
      continue
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue
      if (skipNames?.has(dirent.name)) continue
      const folderPath = join(base, dirent.name)
      let folderStat
      try {
        folderStat = await lstat(folderPath)
      } catch {
        continue
      }
      if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) {
        if (folderStat.isSymbolicLink()) unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
        continue
      }
      let children: string[]
      try {
        children = await readdir(folderPath)
      } catch {
        unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
        continue
      }
      const notes = children.filter((child) => child.toLowerCase().endsWith(".md"))
      // Primary is strictly the case-insensitive exact `{folder}.md` note.
      // A sole ancillary note (Emails.md, Links.md, ...) must never be
      // treated as primary.
      const exact = notes.find((note) => note === `${dirent.name}.md`)
      const folded = notes.find((note) => note.toLowerCase() === `${dirent.name.toLowerCase()}.md`)
      const primaryName = exact ?? folded
      let primaryFrontmatter: Record<string, unknown> = {}
      let hasPrimary = false
      if (primaryName !== undefined) {
        const primaryPath = join(folderPath, primaryName)
        try {
          if ((await lstat(primaryPath)).isSymbolicLink()) {
            unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
            wikiReconcileLog(logger, "warn", `wiki: skipping symlinked note ${primaryPath}`)
            continue
          }
        } catch {
          continue
        }
        try {
          const raw = await readFile(primaryPath, "utf8")
          const split = wikiNoteSplit(raw)
          if (split.frontmatterText !== null) {
            const parsed = wikiFrontmatterParse(split.frontmatterText)
            if (!parsed) {
              unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
              wikiReconcileLog(logger, "warn", `wiki: skipping note with unparseable frontmatter ${primaryPath}`)
              continue
            }
            primaryFrontmatter = parsed
          }
        } catch (error) {
          unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
          wikiReconcileLog(logger, "warn", `wiki: skipping unreadable note ${primaryPath}: ${(error as Error).message}`)
          continue
        }
        hasPrimary = true
      }
      const ancillaries: WikiProjectEntry["ancillaries"] = []
      for (const note of notes) {
        if (primaryName !== undefined && note === primaryName) continue
        const ancillaryPath = join(folderPath, note)
        try {
          if ((await lstat(ancillaryPath)).isSymbolicLink()) {
            unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
            wikiReconcileLog(logger, "warn", `wiki: skipping symlinked note ${ancillaryPath}`)
            continue
          }
        } catch {
          continue
        }
        try {
          const raw = await readFile(ancillaryPath, "utf8")
          const split = wikiNoteSplit(raw)
          let frontmatter: Record<string, unknown> = {}
          if (split.frontmatterText !== null) {
            const parsed = wikiFrontmatterParse(split.frontmatterText)
            if (!parsed) {
              unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
              wikiReconcileLog(logger, "warn", `wiki: skipping note with unparseable frontmatter ${ancillaryPath}`)
              continue
            }
            frontmatter = parsed
          }
          ancillaries.push({ noteName: note, notePath: ancillaryPath, frontmatter })
        } catch (error) {
          unsafeFolderNorms.add(wikiProjectNameNormalize(dirent.name))
          wikiReconcileLog(
            logger,
            "warn",
            `wiki: skipping unreadable note ${ancillaryPath}: ${(error as Error).message}`,
          )
          continue
        }
      }
      const noteName = primaryName ?? `${dirent.name}.md`
      entries.push({
        parent,
        folder: dirent.name,
        folderPath,
        notePath: join(folderPath, noteName),
        noteName,
        frontmatter: primaryFrontmatter,
        hasPrimary,
        ancillaries,
      })
    }
  }
  return { entries, unsafeFolderNorms }
}

export async function wikiReconcile(input: WikiReconcileInput): Promise<Result<WikiReconcileSummary>> {
  const op = "wikiReconcile"
  const owner = input.owner ?? "leo"
  if (owner.trim() === "") return createResultError(op, "wiki owner must not be empty")
  if (typeof input.root !== "string" || input.root === "" || input.root.includes("\0")) {
    return createResultError(op, "wiki root must be a non-empty path")
  }
  const root = resolve(input.root)
  let rootStat
  try {
    rootStat = await stat(root)
  } catch {
    return createResultError(op, `wiki root does not exist: ${root}`)
  }
  if (!rootStat.isDirectory()) return createResultError(op, `wiki root is not a directory: ${root}`)

  const snapshot = input.snapshot
  const snapshotProjects: readonly unknown[] =
    snapshot !== undefined && !Array.isArray(snapshot) && "projects" in snapshot ? snapshot.projects : (snapshot ?? [])
  const rawInputs: readonly unknown[] = [...(input.projects ?? []), ...snapshotProjects]
  const projects: ProjectCanonical[] = []
  const summary: WikiReconcileSummary = {
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    skippedMessages: [],
  }
  const skip = (message: string): void => {
    summary.skipped += 1
    summary.skippedMessages.push(message)
    wikiReconcileLog(input.logger, "warn", `wiki: ${message}`)
  }
  for (const raw of rawInputs) {
    const parsed = a.safeParse(projectCanonicalSchema, wikiReconcileUnwrap(raw))
    if (!parsed.success) {
      skip(`skipping invalid canonical project: ${a.summarize(parsed.issues)}`)
      continue
    }
    if (parsed.output.owner !== owner) {
      skip(`skipping project ${parsed.output.owner}/${parsed.output.name}: owner is not ${owner}`)
      continue
    }
    projects.push(parsed.output)
  }

  const scanned = await wikiReconcileScan(root, input.logger)
  let tmpCounter = 0

  for (const project of projects) {
    summary.processed += 1
    const label = `${project.owner}/${project.name}`
    const resolution = wikiProjectResolve(project, scanned.entries)
    if (resolution.kind === "ambiguous") {
      const paths = resolution.entries.map((entry) => entry.notePath).join(", ")
      skip(`skipping ${label}: ambiguous match, not creating a duplicate (${paths})`)
      continue
    }

    let folderPath: string
    let notePath: string
    let spelling: string
    if (resolution.kind === "none") {
      const alternativeName = project.labels.alternativeName?.trim()
      spelling = alternativeName && alternativeName !== "" ? alternativeName : project.name
      if (!wikiReconcileSegmentSafe(spelling)) {
        skip(`skipping ${label}: unsafe project spelling ${JSON.stringify(spelling)}`)
        continue
      }
      if (scanned.unsafeFolderNorms.has(wikiProjectNameNormalize(spelling))) {
        skip(`skipping ${label}: unsafe existing match, not creating a duplicate`)
        continue
      }
      const isCustomer = project.labels.section?.trim().toLowerCase() === "kunden"
      const parent = isCustomer ? "Externe" : "Interne"
      folderPath = join(root, "Projekte", parent, spelling)
      notePath = join(folderPath, `${spelling}.md`)
    } else {
      folderPath = resolution.entry.folderPath
      notePath = resolution.entry.notePath
      spelling = resolution.entry.folder
    }

    if (!(await wikiReconcilePathInsideTree(root, notePath))) {
      skip(`skipping ${label}: note path escapes the wiki tree or crosses a symlink`)
      continue
    }

    try {
      const createdDir = await wikiReconcileEnsureDir(folderPath, rootStat.uid, rootStat.gid, input.logger, label)
      if (createdDir) {
        scanned.unsafeFolderNorms.delete(wikiProjectNameNormalize(basename(folderPath)))
      } else {
        try {
          if (!(await lstat(folderPath)).isDirectory()) {
            skip(`skipping ${label}: project folder is not a directory`)
            continue
          }
        } catch {
          skip(`skipping ${label}: project folder is not a directory`)
          continue
        }
      }
      await wikiReconcileEnsureDir(
        join(folderPath, "Sprachprotokolle"),
        rootStat.uid,
        rootStat.gid,
        input.logger,
        label,
      )
    } catch (error) {
      skip(`skipping ${label}: cannot prepare project folder ${folderPath}: ${(error as Error).message}`)
      continue
    }

    let existingRaw: string | null = null
    try {
      existingRaw = await readFile(notePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        skip(`skipping ${label}: cannot read note ${notePath}`)
        continue
      }
    }
    if (existingRaw !== null) {
      try {
        if ((await lstat(notePath)).isSymbolicLink()) {
          skip(`skipping ${label}: note is a symlink outside the wiki tree`)
          continue
        }
      } catch {
        skip(`skipping ${label}: cannot read note ${notePath}`)
        continue
      }
    }

    let frontmatter: Record<string, unknown> = {}
    let body = `# ${spelling}\n`
    if (existingRaw !== null) {
      const split = wikiNoteSplit(existingRaw)
      if (split.frontmatterText !== null) {
        const parsed = wikiFrontmatterParse(split.frontmatterText)
        if (!parsed) {
          skip(`skipping ${label}: unparseable frontmatter in ${notePath}`)
          continue
        }
        frontmatter = parsed
      }
      body = split.body
    }

    const next = wikiNoteSerialize(wikiNoteFrontmatterMerge(frontmatter, project), body)
    if (existingRaw === next) {
      summary.unchanged += 1
    } else {
      const isNewFile = existingRaw === null
      try {
        tmpCounter += 1
        const tmpPath = `${notePath}.tmp-${process.pid}-${tmpCounter}`
        await writeFile(tmpPath, next, "utf8")
        // Own the temp file before the atomic rename so new and rewritten notes
        // alike keep Leo-readable ownership with no half-owned window.
        await wikiReconcileChownNew(tmpPath, rootStat.uid, rootStat.gid, input.logger, label)
        await rename(tmpPath, notePath)
      } catch (error) {
        try {
          await rm(`${notePath}.tmp-${process.pid}-${tmpCounter}`, { force: true })
        } catch {
          // Ignore tmp cleanup failures.
        }
        skip(`skipping ${label}: cannot write note ${notePath}: ${(error as Error).message}`)
        continue
      }
      if (isNewFile) summary.created += 1
      else summary.updated += 1
      wikiReconcileLog(input.logger, "info", `wiki: synced ${label} -> ${notePath}`)
    }

    // Migrate registry-owned metadata off ancillary notes in the resolved
    // folder. Only notes whose namespaced projectRegistry identity exactly
    // matches this project are touched; unknown frontmatter keys and the
    // body are byte-preserved and ancillary files are never renamed/deleted.
    if (resolution.kind !== "none") {
      for (const ancillary of resolution.entry.ancillaries) {
        if (!(await wikiReconcilePathInsideTree(root, ancillary.notePath))) {
          wikiReconcileLog(
            input.logger,
            "warn",
            `wiki: skipping ancillary note outside the wiki tree ${ancillary.notePath}`,
          )
          continue
        }
        let ancillaryRaw: string | null = null
        try {
          ancillaryRaw = await readFile(ancillary.notePath, "utf8")
        } catch {
          continue
        }
        try {
          if ((await lstat(ancillary.notePath)).isSymbolicLink()) continue
        } catch {
          continue
        }
        const split = wikiNoteSplit(ancillaryRaw)
        if (split.frontmatterText === null) continue
        const parsed = wikiFrontmatterParse(split.frontmatterText)
        if (!parsed) continue
        if (!wikiAncillaryIdentityMatches(project, parsed)) continue
        const cleaned = wikiAncillaryStripManaged(parsed)
        const cleanedRaw = Object.keys(cleaned).length === 0 ? split.body : wikiNoteSerialize(cleaned, split.body)
        if (cleanedRaw === ancillaryRaw) continue
        try {
          tmpCounter += 1
          const tmpPath = `${ancillary.notePath}.tmp-${process.pid}-${tmpCounter}`
          await writeFile(tmpPath, cleanedRaw, "utf8")
          await wikiReconcileChownNew(tmpPath, rootStat.uid, rootStat.gid, input.logger, label)
          await rename(tmpPath, ancillary.notePath)
        } catch (error) {
          try {
            await rm(`${ancillary.notePath}.tmp-${process.pid}-${tmpCounter}`, { force: true })
          } catch {
            // Ignore tmp cleanup failures.
          }
          wikiReconcileLog(
            input.logger,
            "warn",
            `wiki: cannot clean ancillary note ${ancillary.notePath}: ${(error as Error).message}`,
          )
          continue
        }
        summary.updated += 1
        wikiReconcileLog(input.logger, "info", `wiki: cleaned ancillary note ${ancillary.notePath}`)
      }
    }
  }

  return createResult(summary)
}
