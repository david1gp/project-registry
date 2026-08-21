import { dlopen, FFIType } from "bun:ffi"
import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises"
import { join, posix } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { projectAccessLogCaddyRetention } from "./projectAccessLogCaddyRetention.js"
import { projectAccessLogOpenat2 } from "./projectAccessLogOpenat2.js"
import { projectAccessLogRetentionMaximumActiveProjectIds } from "./projectAccessLogRetentionMaximumActiveProjectIds.js"
import { projectAccessLogRootSchema } from "./projectAccessLogRootSchema.js"

const metadataName = ".project-registry-retention.json"
const metadataTemporaryNamePrefix = `${metadataName}.tmp-`
const metadataTemporaryNamePattern =
  /^\.project-registry-retention\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const quarantineDirectoryName = "quarantine"
const metadataMaximumBytes = 4 * 1024
const metadataTemporaryCreateAttempts = 8
const metadataTemporaryMaximumFiles = 8
const maximumProjectEntries = 1_024
const maximumWorkEntries = 4_096
const retentionWindowMs = projectAccessLogCaddyRetention.rollKeepDays * 24 * 60 * 60 * 1_000
const quarantineGraceMs = 24 * 60 * 60 * 1_000
const archiveNamePattern = /^access-[A-Za-z0-9_.-]+\.jsonl(?:\.gz)?$/
const projectIdPattern = /^[a-f0-9]{64}$/
const noFollowFlag = constants.O_NOFOLLOW ?? 0
const directoryFlag = constants.O_DIRECTORY ?? 0
const nonBlockingFlag = constants.O_NONBLOCK ?? 0
const descriptorDirectoryFlags = constants.O_RDONLY | directoryFlag | noFollowFlag
const descriptorFileFlags = constants.O_RDONLY | noFollowFlag | nonBlockingFlag
const descriptorTraversalAvailable = noFollowFlag !== 0 && directoryFlag !== 0
const renameNoReplaceFlag = 1

type FileHandle = Awaited<ReturnType<typeof open>>

type RetentionSyncPurpose =
  | "metadata-namespace"
  | "quarantine-namespace"
  | "quarantine-rename-source"
  | "quarantine-rename-destination"

type RetentionFileSystem = {
  syncDirectory: (directory: FileHandle, purpose: RetentionSyncPurpose) => Promise<void>
  beforeQuarantineRename?: () => Promise<void>
  afterQuarantineRename?: () => Promise<void>
}

const retentionFileSystemDefault: RetentionFileSystem = {
  syncDirectory: async (directory) => {
    await directory.sync()
  },
}

type RenameAt2 = (oldDirectory: number, oldName: string, newDirectory: number, newName: string, flags: number) => number

const renameAt2: RenameAt2 | undefined = (() => {
  if (process.platform !== "linux") return undefined
  try {
    return dlopen("libc.so.6", {
      renameat2: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
        returns: FFIType.i32,
      },
    }).symbols.renameat2 as unknown as RenameAt2
  } catch {
    return undefined
  }
})()

type ReconcileOptions = {
  root: string
  activeProjectIds: readonly string[]
  now: number
  stillCurrent: () => boolean
  filesystem: RetentionFileSystem
}

type RetentionMetadata =
  | { version: 1; state: "active" }
  | { version: 1; state: "inactive"; inactiveAt: number }
  | { version: 1; state: "quarantined"; inactiveAt: number; quarantinedAt: number }

type MetadataRead =
  | { kind: "missing" }
  | { kind: "valid"; data: RetentionMetadata }
  | { kind: "malformed" }
  | { kind: "unavailable" }

type DirectoryChild = {
  name: string
  stat: Stats
}

type ProjectDirectory = {
  id: string
  stat: Stats
}

type WorkBudget = {
  entries: number
}

let reconciliationFlight: Promise<void> = Promise.resolve()

function retentionError(message: string, errorData?: string): ReturnType<typeof createResultError> {
  return createResultError("projectAccessLogRetentionReconcile", message, errorData)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}

function descriptorChildPath(directory: FileHandle, name: string): string {
  return `/proc/self/fd/${directory.fd}/${name}`
}

async function fileHandleClose(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return
  try {
    await handle.close()
  } catch {
    // The reconciliation result is already determined; close failures must not escape.
  }
}

function statSameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function directoryRenameNoReplace(
  source: FileHandle,
  sourceName: string,
  destination: FileHandle,
  destinationName: string,
): boolean {
  // fs.rename replaces an existing empty directory. renameat2 with RENAME_NOREPLACE keeps a collision intact.
  if (renameAt2 === undefined) return false
  try {
    return renameAt2(source.fd, sourceName, destination.fd, destinationName, renameNoReplaceFlag) === 0
  } catch {
    return false
  }
}

function retentionOptionsNormalize(options: unknown): Result<ReconcileOptions> {
  const op = "projectAccessLogRetentionReconcile"
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      return createResultError(op, "retention reconciliation options are invalid")
    }

    const input = options as {
      root?: unknown
      activeProjectIds?: unknown
      now?: unknown
      stillCurrent?: unknown
      filesystem?: unknown
    }
    if (typeof input.root !== "string") return createResultError(op, "retention reconciliation root is invalid")
    const rootR = a.safeParse(projectAccessLogRootSchema, input.root)
    if (!rootR.success) return createResultError(op, a.summarize(rootR.issues))
    if (!Array.isArray(input.activeProjectIds)) {
      return createResultError(op, "retention reconciliation active project IDs are invalid")
    }
    if (input.activeProjectIds.length > projectAccessLogRetentionMaximumActiveProjectIds) {
      return createResultError(
        op,
        `retention reconciliation active project ID limit exceeded (maximum ${projectAccessLogRetentionMaximumActiveProjectIds})`,
      )
    }
    const activeProjectIds: string[] = []
    for (const id of input.activeProjectIds) {
      if (typeof id !== "string" || !projectIdPattern.test(id)) {
        return createResultError(op, "retention reconciliation active project IDs are invalid")
      }
      if (activeProjectIds.includes(id)) {
        return createResultError(op, "retention reconciliation active project IDs must be unique")
      }
      activeProjectIds.push(id)
    }
    const now = input.now ?? Date.now()
    if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
      return createResultError(op, "retention reconciliation time is invalid")
    }
    if (input.stillCurrent !== undefined && typeof input.stillCurrent !== "function") {
      return createResultError(op, "retention reconciliation current-state guard is invalid")
    }
    if (
      input.filesystem !== undefined &&
      (typeof input.filesystem !== "object" ||
        input.filesystem === null ||
        Array.isArray(input.filesystem) ||
        typeof (input.filesystem as { syncDirectory?: unknown }).syncDirectory !== "function")
    ) {
      return createResultError(op, "retention reconciliation filesystem is invalid")
    }
    const stillCurrent = typeof input.stillCurrent === "function" ? (input.stillCurrent as () => boolean) : undefined
    const filesystem = input.filesystem as RetentionFileSystem | undefined
    return createResult({
      root: rootR.output,
      activeProjectIds,
      now,
      stillCurrent: stillCurrent ?? (() => true),
      filesystem: filesystem ?? retentionFileSystemDefault,
    })
  } catch {
    return createResultError(op, "retention reconciliation options are invalid")
  }
}

async function directoryOpenRelative(
  parent: FileHandle,
  name: string,
  path: string,
  rootAnchor = false,
): Promise<Result<FileHandle | undefined>> {
  if (!descriptorTraversalAvailable) return retentionError("descriptor-relative access is unavailable", path)
  return projectAccessLogOpenat2({
    directoryFd: parent.fd,
    name,
    flags: descriptorDirectoryFlags,
    path,
    rootAnchor,
  })
}

async function rootDirectoryOpen(root: string): Promise<Result<FileHandle | undefined>> {
  if (!descriptorTraversalAvailable) return retentionError("descriptor-relative access is unavailable", root)
  let current: FileHandle | undefined
  let retained = false
  let currentPath = "/"
  try {
    current = await open("/", descriptorDirectoryFlags)
    const parts = root.split("/").filter((value) => value.length > 0)
    if (parts.length === 0) {
      const rootR = await directoryOpenRelative(current, ".", root, true)
      await fileHandleClose(current)
      current = undefined
      if (!rootR.success) return rootR
      if (rootR.data === undefined) return createResult(undefined)
      current = rootR.data
    }
    for (const [index, part] of parts.entries()) {
      // Mounts before the configured root are allowed so roots on a separate filesystem still work. The root itself
      // and every descendant are opened with RESOLVE_NO_XDEV.
      const nextR = await directoryOpenRelative(current, part, join(currentPath, part), index < parts.length - 1)
      await fileHandleClose(current)
      current = undefined
      if (!nextR.success) return nextR
      if (nextR.data === undefined) return createResult(undefined)
      current = nextR.data
      currentPath = join(currentPath, part)
    }
    retained = true
    return createResult(current)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return createResult(undefined)
    return retentionError("retention root could not be opened", root)
  } finally {
    if (!retained) await fileHandleClose(current)
  }
}

async function directoryEntriesRead(
  directory: FileHandle,
  path: string,
  budget: WorkBudget,
  maximumEntries = maximumProjectEntries,
): Promise<Result<readonly DirectoryChild[]>> {
  let names: string[]
  try {
    names = await readdir(descriptorChildPath(directory, "."))
  } catch {
    return retentionError("retention directory could not be read", path)
  }

  const entries: DirectoryChild[] = []
  for (const name of names) {
    budget.entries += 1
    if (budget.entries > maximumWorkEntries || entries.length >= maximumEntries) {
      return retentionError("retention directory entry limit exceeded", path)
    }
    try {
      entries.push({ name, stat: await lstat(descriptorChildPath(directory, name)) })
    } catch {
      return retentionError("retention directory changed while being inspected", path)
    }
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return createResult(entries)
}

function metadataParse(value: unknown): RetentionMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const version = (value as { version?: unknown }).version
  const state = (value as { state?: unknown }).state
  if (version !== 1 || (state !== "active" && state !== "inactive" && state !== "quarantined")) return undefined
  const keys = Object.keys(value)
  if (state === "active") {
    if (keys.length !== 2 || !keys.includes("version") || !keys.includes("state")) return undefined
    return { version: 1, state: "active" }
  }
  if (state === "quarantined") {
    if (
      keys.length !== 4 ||
      !keys.includes("version") ||
      !keys.includes("state") ||
      !keys.includes("inactiveAt") ||
      !keys.includes("quarantinedAt")
    ) {
      return undefined
    }
    const inactiveAt = (value as { inactiveAt?: unknown }).inactiveAt
    const quarantinedAt = (value as { quarantinedAt?: unknown }).quarantinedAt
    if (
      typeof inactiveAt !== "number" ||
      !Number.isSafeInteger(inactiveAt) ||
      inactiveAt < 0 ||
      typeof quarantinedAt !== "number" ||
      !Number.isSafeInteger(quarantinedAt) ||
      quarantinedAt < 0 ||
      quarantinedAt < inactiveAt
    ) {
      return undefined
    }
    return { version: 1, state: "quarantined", inactiveAt, quarantinedAt }
  }
  if (keys.length !== 3 || !keys.includes("version") || !keys.includes("state") || !keys.includes("inactiveAt")) {
    return undefined
  }
  const inactiveAt = (value as { inactiveAt?: unknown }).inactiveAt
  if (typeof inactiveAt !== "number" || !Number.isSafeInteger(inactiveAt) || inactiveAt < 0) return undefined
  return { version: 1, state: "inactive", inactiveAt }
}

function quarantineLogFileKnown(name: string): boolean {
  return name === "access.jsonl" || archiveNamePattern.test(name)
}

function quarantineGraceExpired(quarantinedAt: number, now: number): boolean {
  return quarantinedAt <= now && now - quarantinedAt >= quarantineGraceMs
}

async function metadataRead(directory: FileHandle): Promise<MetadataRead> {
  const path = descriptorChildPath(directory, metadataName)
  let listedStat: Stats
  try {
    listedStat = await lstat(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" }
    return { kind: "unavailable" }
  }
  if (listedStat.isSymbolicLink() || !listedStat.isFile() || listedStat.size > metadataMaximumBytes) {
    return { kind: "malformed" }
  }

  let handle: FileHandle | undefined
  try {
    const openR = await projectAccessLogOpenat2({
      directoryFd: directory.fd,
      name: metadataName,
      flags: descriptorFileFlags,
      path,
    })
    if (!openR.success) return { kind: openR.errorMessage.includes("symbolic link") ? "malformed" : "unavailable" }
    if (openR.data === undefined) return { kind: "unavailable" }
    handle = openR.data
    const openedStat = await handle.stat()
    if (!openedStat.isFile() || !statSameObject(listedStat, openedStat) || openedStat.size > metadataMaximumBytes) {
      return { kind: "malformed" }
    }
    const data = Buffer.alloc(metadataMaximumBytes + 1)
    const readR = await handle.read(data, 0, data.length, 0)
    if (readR.bytesRead !== openedStat.size || readR.bytesRead > metadataMaximumBytes) return { kind: "malformed" }
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, readR.bytesRead))
    } catch {
      return { kind: "malformed" }
    }
    try {
      const parsed = metadataParse(JSON.parse(text))
      return parsed === undefined ? { kind: "malformed" } : { kind: "valid", data: parsed }
    } catch {
      return { kind: "malformed" }
    }
  } catch {
    return { kind: "unavailable" }
  } finally {
    await fileHandleClose(handle)
  }
}

async function metadataTemporaryFileCleanup(
  directory: FileHandle,
  name: string | undefined,
  expectedStat: Stats | undefined,
): Promise<boolean> {
  if (name === undefined) return true
  if (expectedStat === undefined) return false
  const path = descriptorChildPath(directory, name)
  let handle: FileHandle | undefined
  try {
    const openR = await projectAccessLogOpenat2({
      directoryFd: directory.fd,
      name,
      flags: descriptorFileFlags,
      path,
    })
    if (!openR.success) return false
    if (openR.data === undefined) {
      try {
        await lstat(path)
        return false
      } catch (error) {
        return errorCode(error) === "ENOENT"
      }
    }
    handle = openR.data
    const currentStat = await handle.stat()
    if (!currentStat.isFile() || !statSameObject(currentStat, expectedStat)) return false
    await fileHandleClose(handle)
    handle = undefined
    const listedStat = await lstat(path)
    if (listedStat.isSymbolicLink() || !listedStat.isFile() || !statSameObject(listedStat, expectedStat)) return false
    try {
      await unlink(path)
    } catch (error) {
      return errorCode(error) === "ENOENT"
    }
    try {
      await lstat(path)
      return false
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return false
      try {
        await directory.sync()
      } catch {
        return false
      }
      return true
    }
  } catch (error) {
    return errorCode(error) === "ENOENT"
  } finally {
    await fileHandleClose(handle)
  }
}

function metadataTemporaryFileNameValid(name: string): boolean {
  return metadataTemporaryNamePattern.test(name)
}

function metadataTemporaryFileOwned(stat: Stats, directoryDevice: Stats["dev"]): boolean {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.dev !== directoryDevice ||
    stat.nlink !== 1 ||
    stat.size > metadataMaximumBytes
  ) {
    return false
  }
  if ((stat.mode & 0o7777) !== 0o600) return false
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false
  if (typeof process.getgid === "function" && stat.gid !== process.getgid()) return false
  return true
}

function metadataTemporaryTextPrefixValid(text: string): boolean {
  const active = '{"version":1,"state":"active"}'
  const inactive = '{"version":1,"state":"inactive","inactiveAt":'
  const quarantined = '{"version":1,"state":"quarantined","inactiveAt":'
  if (active.startsWith(text)) return true
  if (text === "") return true

  for (const prefix of [inactive, quarantined]) {
    if (text === prefix.slice(0, text.length) && text.length < prefix.length) return true
    if (!text.startsWith(prefix)) continue
    const remainder = text.slice(prefix.length)
    if (/^\d*$/.test(remainder)) return true
    if (prefix !== quarantined) continue
    const quarantineMarker = ',"quarantinedAt":'
    if (quarantineMarker.startsWith(remainder)) return true
    if (!remainder.startsWith(quarantineMarker)) continue
    if (/^,\"quarantinedAt\":\d*$/.test(remainder)) return true
  }
  return false
}

async function metadataTemporaryFileContentsValid(handle: FileHandle, size: number): Promise<boolean> {
  const data = Buffer.alloc(metadataMaximumBytes + 1)
  const readR = await handle.read(data, 0, data.length, 0)
  if (readR.bytesRead !== size || readR.bytesRead > metadataMaximumBytes) return false
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, readR.bytesRead))
  } catch {
    return false
  }
  if (metadataTemporaryTextPrefixValid(text)) return true
  try {
    return metadataParse(JSON.parse(text)) !== undefined
  } catch {
    return false
  }
}

async function metadataTemporaryFileCandidateExists(
  directory: FileHandle,
  path: string,
  budget: WorkBudget,
): Promise<Result<boolean>> {
  const namesR = await metadataTemporaryDirectoryNamesRead(directory, path, budget)
  if (!namesR.success) return namesR
  const names = namesR.data
  return createResult(names.some(metadataTemporaryFileNameValid))
}

async function metadataTemporaryDirectoryNamesRead(
  directory: FileHandle,
  path: string,
  budget: WorkBudget,
  directoryName = ".",
): Promise<Result<readonly string[]>> {
  if (directoryName !== ".") {
    return retentionError("retention directory child name is invalid", path)
  }
  const entriesR = await directoryEntriesRead(directory, path, budget)
  if (!entriesR.success) return entriesR
  return createResult(entriesR.data.map((entry) => entry.name))
}

async function metadataTemporaryFilesCleanup(
  directory: FileHandle,
  path: string,
  budget: WorkBudget,
  filesystem: RetentionFileSystem,
): PromiseResult<{ removed: number; empty: boolean }> {
  const directoryStat = await directory.stat()
  const namesR = await metadataTemporaryDirectoryNamesRead(directory, path, budget)
  if (!namesR.success) return namesR
  const names = [...namesR.data]
  const temporaryEntries: DirectoryChild[] = []
  for (const name of names) {
    if (!metadataTemporaryFileNameValid(name)) continue
    try {
      temporaryEntries.push({ name, stat: await lstat(descriptorChildPath(directory, name)) })
    } catch {
      return retentionError("retention directory changed while being inspected", path)
    }
  }
  if (temporaryEntries.length > metadataTemporaryMaximumFiles) {
    return createResult({ removed: 0, empty: names.length === 0 })
  }

  let removed = 0
  for (const entry of temporaryEntries) {
    if (!metadataTemporaryFileOwned(entry.stat, directoryStat.dev)) continue

    const entryPath = descriptorChildPath(directory, entry.name)
    let handle: FileHandle | undefined
    try {
      const openR = await projectAccessLogOpenat2({
        directoryFd: directory.fd,
        name: entry.name,
        flags: descriptorFileFlags,
        path: entryPath,
      })
      if (!openR.success || openR.data === undefined) continue
      handle = openR.data
      const openedStat = await handle.stat()
      if (
        !metadataTemporaryFileOwned(openedStat, directoryStat.dev) ||
        !statSameObject(openedStat, entry.stat) ||
        !(await metadataTemporaryFileContentsValid(handle, openedStat.size))
      ) {
        continue
      }
    } catch {
      continue
    } finally {
      await fileHandleClose(handle)
    }

    let currentStat: Stats
    try {
      currentStat = await lstat(entryPath)
    } catch {
      continue
    }
    if (!metadataTemporaryFileOwned(currentStat, directoryStat.dev) || !statSameObject(currentStat, entry.stat))
      continue

    try {
      await unlink(entryPath)
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        return retentionError("retention metadata temporary file could not be removed", path)
      continue
    }
    try {
      await lstat(entryPath)
      return retentionError("retention metadata temporary file removal became ambiguous", path)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return retentionError("retention metadata temporary file removal could not be verified", path)
      }
    }
    removed += 1
  }

  if (removed > 0) {
    try {
      await filesystem.syncDirectory(directory, "metadata-namespace")
    } catch {
      return retentionError("retention metadata temporary file removal could not be made durable", path)
    }
  }

  if (removed === 0) return createResult({ removed, empty: names.length === 0 })
  const finalNamesR = await metadataTemporaryDirectoryNamesRead(directory, path, budget)
  if (!finalNamesR.success) return finalNamesR
  return createResult({ removed, empty: finalNamesR.data.length === 0 })
}

async function metadataWrite(
  directory: FileHandle,
  data: RetentionMetadata,
  stillCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!descriptorTraversalAvailable) return false
  const serialized = JSON.stringify(data)
  const encoded = Buffer.from(serialized, "utf8")
  if (encoded.byteLength > metadataMaximumBytes) return false

  let handle: FileHandle | undefined
  let temporaryPath: string | undefined
  let temporaryName: string | undefined
  let temporaryStat: Stats | undefined
  let success = false
  try {
    for (let attempt = 0; attempt < metadataTemporaryCreateAttempts; attempt += 1) {
      const candidateName = `${metadataTemporaryNamePrefix}${randomUUID()}`
      const candidatePath = descriptorChildPath(directory, candidateName)
      const openR = await projectAccessLogOpenat2({
        directoryFd: directory.fd,
        name: candidateName,
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
        mode: 0o600,
        path: candidatePath,
      })
      if (!openR.success) {
        if (openR.errorMessage.includes("existing entry")) continue
        return false
      }
      if (openR.data === undefined) return false
      handle = openR.data
      temporaryPath = candidatePath
      temporaryName = candidateName
      break
    }
    if (handle === undefined || temporaryPath === undefined || temporaryName === undefined) return false

    temporaryStat = await handle.stat()
    if (!temporaryStat.isFile()) return false

    let offset = 0
    while (offset < encoded.byteLength) {
      const writeR = await handle.write(encoded, offset, encoded.byteLength - offset, offset)
      if (writeR.bytesWritten <= 0) return false
      offset += writeR.bytesWritten
    }
    const writtenStat = await handle.stat()
    if (
      !writtenStat.isFile() ||
      writtenStat.size !== encoded.byteLength ||
      !statSameObject(writtenStat, temporaryStat)
    ) {
      return false
    }
    await handle.sync()
    await fileHandleClose(handle)
    handle = undefined

    const currentR = await projectAccessLogOpenat2({
      directoryFd: directory.fd,
      name: temporaryName,
      flags: descriptorFileFlags,
      path: temporaryPath,
    })
    if (!currentR.success || currentR.data === undefined) return false
    const currentHandle = currentR.data
    try {
      const currentStat = await currentHandle.stat()
      if (!currentStat.isFile() || !statSameObject(currentStat, temporaryStat)) return false
    } finally {
      await fileHandleClose(currentHandle)
    }
    if (!stillCurrent()) return false
    await rename(temporaryPath, descriptorChildPath(directory, metadataName))
    temporaryPath = undefined
    temporaryName = undefined
    await directory.sync()
    success = true
  } catch {
    // The previous metadata path is untouched until the verified temporary file is renamed over it.
  } finally {
    await fileHandleClose(handle)
    if (!(await metadataTemporaryFileCleanup(directory, temporaryName, temporaryStat))) success = false
  }
  return success
}

async function projectDirectoryOpen(
  projects: FileHandle,
  project: ProjectDirectory,
  projectsDevice: Stats["dev"],
): Promise<FileHandle | undefined> {
  const path = descriptorChildPath(projects, project.id)
  let handle: FileHandle | undefined
  try {
    const listedStat = await lstat(path)
    if (!listedStat.isDirectory() || listedStat.isSymbolicLink() || !statSameObject(listedStat, project.stat))
      return undefined
    if (listedStat.dev !== projectsDevice) return undefined
    const openR = await projectAccessLogOpenat2({
      directoryFd: projects.fd,
      name: project.id,
      flags: descriptorDirectoryFlags,
      path,
    })
    if (!openR.success || openR.data === undefined) return undefined
    handle = openR.data
    const openedStat = await handle.stat()
    if (!openedStat.isDirectory() || !statSameObject(openedStat, project.stat) || openedStat.dev !== projectsDevice) {
      await fileHandleClose(handle)
      return undefined
    }
    const retained = handle
    handle = undefined
    return retained
  } catch {
    await fileHandleClose(handle)
    return undefined
  }
}

async function quarantineDirectoryOpen(
  root: FileHandle,
  device: Stats["dev"],
  create: boolean,
  filesystem: RetentionFileSystem,
): Promise<Result<FileHandle | undefined>> {
  const path = descriptorChildPath(root, quarantineDirectoryName)
  if (create) {
    let created = false
    try {
      await mkdir(path, 0o700)
      created = true
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        return retentionError("retention quarantine directory could not be created", path)
      }
    }
    if (created) {
      try {
        await filesystem.syncDirectory(root, "quarantine-namespace")
      } catch {
        return retentionError("retention quarantine directory creation could not be made durable", path)
      }
    }
  }

  const directoryR = await directoryOpenRelative(root, quarantineDirectoryName, path)
  if (!directoryR.success) return directoryR
  if (directoryR.data === undefined) return createResult(undefined)

  let directoryStat: Stats
  try {
    directoryStat = await directoryR.data.stat()
  } catch {
    await fileHandleClose(directoryR.data)
    return retentionError("retention quarantine directory could not be inspected", path)
  }
  if (!directoryStat.isDirectory() || directoryStat.dev !== device || (directoryStat.mode & 0o077) !== 0) {
    await fileHandleClose(directoryR.data)
    return retentionError("retention quarantine directory is not restrictive", path)
  }
  return directoryR
}

async function projectDirectoryVerifyFlat(
  directory: FileHandle,
  path: string,
  budget: WorkBudget,
): Promise<Result<boolean>> {
  const entriesR = await directoryEntriesRead(directory, path, budget)
  if (!entriesR.success) return entriesR

  // Caddy's access-log directory is flat. Refuse unexpected child directories and special files rather than
  // recursively traversing a mount or a race-prone tree.
  for (const entry of entriesR.data) {
    if (entry.stat.isDirectory() || (!entry.stat.isFile() && !entry.stat.isSymbolicLink())) return createResult(false)
  }

  for (const entry of entriesR.data) {
    const entryPath = descriptorChildPath(directory, entry.name)
    let currentStat: Stats
    try {
      currentStat = await lstat(entryPath)
    } catch {
      return createResult(false)
    }
    if (currentStat.isSymbolicLink()) continue
    if (!currentStat.isFile() || !statSameObject(currentStat, entry.stat)) return createResult(false)
    let file: FileHandle | undefined
    try {
      const openR = await projectAccessLogOpenat2({
        directoryFd: directory.fd,
        name: entry.name,
        flags: descriptorFileFlags,
        path: entryPath,
      })
      if (!openR.success || openR.data === undefined) return createResult(false)
      file = openR.data
      const openedStat = await file.stat()
      if (!openedStat.isFile() || !statSameObject(openedStat, entry.stat)) return createResult(false)
    } catch {
      return createResult(false)
    } finally {
      await fileHandleClose(file)
    }
  }
  return createResult(true)
}

async function projectDirectoryQuarantine(
  projects: FileHandle,
  project: ProjectDirectory,
  projectsDevice: Stats["dev"],
  budget: WorkBudget,
  quarantine: FileHandle,
  now: number,
  inactiveAt: number,
  stillCurrent: () => boolean,
  filesystem: RetentionFileSystem,
): Promise<Result<boolean>> {
  const directory = await projectDirectoryOpen(projects, project, projectsDevice)
  if (directory === undefined) return createResult(false)
  const projectPath = descriptorChildPath(projects, project.id)
  const quarantinePath = descriptorChildPath(quarantine, project.id)
  try {
    const verifiedR = await projectDirectoryVerifyFlat(directory, projectPath, budget)
    if (!verifiedR.success || !verifiedR.data) return verifiedR

    let currentProjectStat: Stats
    try {
      currentProjectStat = await lstat(projectPath)
    } catch {
      return createResult(false)
    }
    if (
      !currentProjectStat.isDirectory() ||
      currentProjectStat.isSymbolicLink() ||
      !statSameObject(currentProjectStat, project.stat) ||
      currentProjectStat.dev !== projectsDevice
    ) {
      return createResult(false)
    }
    const openProjectStat = await directory.stat()
    if (
      !openProjectStat.isDirectory() ||
      !statSameObject(openProjectStat, project.stat) ||
      openProjectStat.dev !== projectsDevice
    ) {
      return createResult(false)
    }

    try {
      await lstat(quarantinePath)
      return createResult(false)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return createResult(false)
    }

    let currentOpenProjectStat: Stats
    try {
      currentOpenProjectStat = await directory.stat()
    } catch {
      return createResult(false)
    }
    if (!statSameObject(currentOpenProjectStat, project.stat) || currentOpenProjectStat.dev !== projectsDevice) {
      return createResult(false)
    }
    const currentMetadata = await metadataRead(directory)
    if (
      currentMetadata.kind !== "valid" ||
      currentMetadata.data.state !== "inactive" ||
      currentMetadata.data.inactiveAt !== inactiveAt
    ) {
      return createResult(false)
    }

    // Re-open the source with openat2 immediately before the namespace transition. This closes the earlier
    // verification window, but renameat2 still accepts a source name rather than an inode-bound descriptor.
    // Linux has no native inode-bound directory rename, so a replacement can still win the tiny gap after this
    // check and before renameat2. The post-rename check must therefore fail closed and leave the target quarantined.
    const preRenameDirectory = await projectDirectoryOpen(projects, project, projectsDevice)
    if (preRenameDirectory === undefined) return createResult(false)
    await fileHandleClose(preRenameDirectory)
    if (!stillCurrent()) return createResult(false)
    await filesystem.beforeQuarantineRename?.()
    if (!directoryRenameNoReplace(projects, project.id, quarantine, project.id)) return createResult(false)

    // Re-open the quarantine target before fsync, metadata writes, or any later cleanup. A source-name replacement
    // may have been moved by renameat2 despite the earlier openat2 verification. Never move an unverified target
    // back into the live projects namespace.
    await filesystem.afterQuarantineRename?.()
    const moved = await projectDirectoryOpen(quarantine, project, projectsDevice)
    if (moved === undefined) return createResult(false)
    try {
      await filesystem.syncDirectory(projects, "quarantine-rename-source")
    } catch {
      return retentionError("retention quarantine source rename could not be made durable", project.id)
    }
    try {
      await filesystem.syncDirectory(quarantine, "quarantine-rename-destination")
    } catch {
      return retentionError("retention quarantine destination rename could not be made durable", project.id)
    }

    try {
      const movedStat = await moved.stat()
      if (!movedStat.isDirectory() || !statSameObject(movedStat, project.stat) || movedStat.dev !== projectsDevice) {
        return createResult(false)
      }
      const movedMetadata = await metadataRead(moved)
      if (
        movedMetadata.kind !== "valid" ||
        movedMetadata.data.state !== "inactive" ||
        movedMetadata.data.inactiveAt !== inactiveAt
      ) {
        return createResult(false)
      }
      return createResult(
        await metadataWrite(moved, { version: 1, state: "quarantined", inactiveAt, quarantinedAt: now }, stillCurrent),
      )
    } finally {
      await fileHandleClose(moved)
    }
  } finally {
    await fileHandleClose(directory)
  }
}

async function quarantineDirectoryCrashCleanup(
  quarantine: FileHandle,
  project: ProjectDirectory,
  quarantineDevice: Stats["dev"],
  budget: WorkBudget,
  filesystem: RetentionFileSystem,
  removeEmpty: boolean,
): PromiseResult<boolean> {
  const childR = await directoryOpenRelative(quarantine, project.id, descriptorChildPath(quarantine, project.id))
  if (!childR.success || childR.data === undefined) return createResult(false)
  let hasTemporaryFile = false
  try {
    const namesR = await metadataTemporaryDirectoryNamesRead(
      childR.data,
      descriptorChildPath(quarantine, project.id),
      budget,
    )
    if (!namesR.success) return namesR
    hasTemporaryFile = namesR.data.some(metadataTemporaryFileNameValid)
  } finally {
    await fileHandleClose(childR.data)
  }
  if (!hasTemporaryFile) return createResult(false)

  const directory = await projectDirectoryOpen(quarantine, project, quarantineDevice)
  if (directory === undefined) return createResult(false)
  const path = descriptorChildPath(quarantine, project.id)
  try {
    const cleanupR = await metadataTemporaryFilesCleanup(directory, path, budget, filesystem)
    if (!cleanupR.success) return cleanupR
    // An empty directory with no daemon-created temporary metadata is ambiguous: it may be an operator's
    // lookalike. Only the observed removal of a validated daemon temporary proves this is a crash-left cleanup
    // remainder.
    if (!removeEmpty || cleanupR.data.removed === 0 || !cleanupR.data.empty) return createResult(false)

    const confirmedDirectory = await projectDirectoryOpen(quarantine, project, quarantineDevice)
    if (confirmedDirectory === undefined) return createResult(false)
    try {
      const confirmedEntriesR = await directoryEntriesRead(confirmedDirectory, path, budget)
      if (!confirmedEntriesR.success) return confirmedEntriesR
      if (confirmedEntriesR.data.length !== 0) return createResult(false)
      const confirmedStat = await confirmedDirectory.stat()
      if (
        !confirmedStat.isDirectory() ||
        !statSameObject(confirmedStat, project.stat) ||
        confirmedStat.dev !== quarantineDevice
      ) {
        return createResult(false)
      }
    } finally {
      await fileHandleClose(confirmedDirectory)
    }

    try {
      await rmdir(path)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return createResult(false)
      return retentionError("crash-left quarantine directory could not be removed", path)
    }
    try {
      await lstat(path)
      return retentionError("crash-left quarantine directory removal became ambiguous", path)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return retentionError("crash-left quarantine directory removal could not be verified", path)
      }
    }
    try {
      await filesystem.syncDirectory(quarantine, "quarantine-namespace")
    } catch {
      return retentionError("crash-left quarantine directory removal could not be made durable", path)
    }
    return createResult(true)
  } finally {
    await fileHandleClose(directory)
  }
}

async function quarantineDirectoryCleanup(
  quarantine: FileHandle,
  project: ProjectDirectory,
  quarantineDevice: Stats["dev"],
  budget: WorkBudget,
  now: number,
  filesystem: RetentionFileSystem,
): Promise<Result<boolean>> {
  const directory = await projectDirectoryOpen(quarantine, project, quarantineDevice)
  if (directory === undefined) return createResult(false)
  const path = descriptorChildPath(quarantine, project.id)
  try {
    const directoryStat = await directory.stat()
    if (
      !directoryStat.isDirectory() ||
      !statSameObject(directoryStat, project.stat) ||
      directoryStat.dev !== quarantineDevice
    ) {
      return createResult(false)
    }

    const metadata = await metadataRead(directory)
    if (metadata.kind !== "valid" || metadata.data.state !== "quarantined") return createResult(false)
    if (!quarantineGraceExpired(metadata.data.quarantinedAt, now)) return createResult(false)

    const entriesR = await directoryEntriesRead(directory, path, budget)
    if (!entriesR.success) return entriesR
    if (entriesR.data.length === 0) return createResult(false)
    for (const entry of entriesR.data) {
      if (
        !entry.stat.isFile() ||
        entry.stat.isSymbolicLink() ||
        entry.stat.dev !== quarantineDevice ||
        (entry.name !== metadataName && !quarantineLogFileKnown(entry.name))
      ) {
        return createResult(false)
      }
    }

    const confirmedMetadata = await metadataRead(directory)
    if (
      confirmedMetadata.kind !== "valid" ||
      confirmedMetadata.data.state !== "quarantined" ||
      confirmedMetadata.data.inactiveAt !== metadata.data.inactiveAt ||
      confirmedMetadata.data.quarantinedAt !== metadata.data.quarantinedAt ||
      !quarantineGraceExpired(confirmedMetadata.data.quarantinedAt, now)
    ) {
      return createResult(false)
    }

    const confirmedDirectoryStat = await directory.stat()
    if (
      !confirmedDirectoryStat.isDirectory() ||
      !statSameObject(confirmedDirectoryStat, directoryStat) ||
      confirmedDirectoryStat.dev !== quarantineDevice
    ) {
      return createResult(false)
    }

    const confirmedEntriesR = await directoryEntriesRead(directory, path, budget)
    if (!confirmedEntriesR.success) return confirmedEntriesR
    if (
      confirmedEntriesR.data.length !== entriesR.data.length ||
      confirmedEntriesR.data.some((entry, index) => {
        const original = entriesR.data[index]
        return (
          original === undefined ||
          entry.name !== original.name ||
          !statSameObject(entry.stat, original.stat) ||
          entry.stat.dev !== original.stat.dev
        )
      })
    ) {
      return createResult(false)
    }

    const entriesToRemove = [...entriesR.data].sort((left, right) => {
      if (left.name === metadataName) return 1
      if (right.name === metadataName) return -1
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
    for (const entry of entriesToRemove) {
      let currentStat: Stats
      try {
        currentStat = await lstat(descriptorChildPath(directory, entry.name))
      } catch {
        return createResult(false)
      }
      if (
        !currentStat.isFile() ||
        currentStat.isSymbolicLink() ||
        currentStat.dev !== quarantineDevice ||
        !statSameObject(currentStat, entry.stat)
      ) {
        return createResult(false)
      }
      const candidateR = await projectAccessLogOpenat2({
        directoryFd: directory.fd,
        name: entry.name,
        flags: descriptorFileFlags,
        path: descriptorChildPath(directory, entry.name),
      })
      if (!candidateR.success || candidateR.data === undefined) return createResult(false)
      try {
        const candidateStat = await candidateR.data.stat()
        if (
          !candidateStat.isFile() ||
          !statSameObject(candidateStat, entry.stat) ||
          candidateStat.dev !== quarantineDevice
        ) {
          return createResult(false)
        }
      } finally {
        await fileHandleClose(candidateR.data)
      }
      try {
        await unlink(descriptorChildPath(directory, entry.name))
      } catch {
        return createResult(false)
      }
    }

    const finalDirectoryStat = await directory.stat()
    if (
      !finalDirectoryStat.isDirectory() ||
      !statSameObject(finalDirectoryStat, directoryStat) ||
      finalDirectoryStat.dev !== quarantineDevice
    ) {
      return createResult(false)
    }
    const finalEntriesR = await directoryEntriesRead(directory, path, budget)
    if (!finalEntriesR.success) return finalEntriesR
    if (finalEntriesR.data.length !== 0) return createResult(false)

    const directoryCandidateR = await projectAccessLogOpenat2({
      directoryFd: quarantine.fd,
      name: project.id,
      flags: descriptorDirectoryFlags,
      path,
    })
    if (!directoryCandidateR.success || directoryCandidateR.data === undefined) return createResult(false)
    try {
      const candidateStat = await directoryCandidateR.data.stat()
      if (
        !candidateStat.isDirectory() ||
        !statSameObject(candidateStat, directoryStat) ||
        candidateStat.dev !== quarantineDevice
      ) {
        return createResult(false)
      }
    } finally {
      await fileHandleClose(directoryCandidateR.data)
    }

    try {
      await rmdir(path)
    } catch {
      return createResult(false)
    }
    try {
      await lstat(path)
      return createResult(false)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return createResult(false)
      try {
        await filesystem.syncDirectory(quarantine, "quarantine-namespace")
      } catch {
        return retentionError("quarantine directory removal could not be made durable", path)
      }
      return createResult(true)
    }
  } finally {
    await fileHandleClose(directory)
  }
}

export type ProjectAccessLogRetentionReconcileOptions = {
  root: string
  activeProjectIds: readonly string[]
  now?: number
  stillCurrent?: () => boolean
  filesystem?: RetentionFileSystem
}

async function projectAccessLogRetentionReconcileRun(options: ReconcileOptions): PromiseResult<true> {
  const { root, activeProjectIds, now, stillCurrent, filesystem } = options
  const active = new Set(activeProjectIds)

  const rootR = await rootDirectoryOpen(root)
  if (!rootR.success) return rootR
  if (rootR.data === undefined) return createResult(true)
  const rootDirectory = rootR.data
  let projectsDirectory: FileHandle | undefined
  let quarantineDirectory: FileHandle | undefined
  let quarantineDevice: Stats["dev"] | undefined
  try {
    const rootStat = await rootDirectory.stat()
    const projectsR = await directoryOpenRelative(rootDirectory, "projects", posix.join(root, "projects"))
    if (!projectsR.success) return projectsR
    if (projectsR.data === undefined) return createResult(true)
    projectsDirectory = projectsR.data
    const projects = projectsDirectory
    const projectsStat = await projects.stat()
    // A mounted projects directory is outside the configured root boundary for this reconciliation.
    if (projectsStat.dev !== rootStat.dev) return createResult(true)

    const budget: WorkBudget = { entries: 0 }
    const quarantineR = await quarantineDirectoryOpen(rootDirectory, projectsStat.dev, false, filesystem)
    if (!quarantineR.success) return quarantineR
    quarantineDirectory = quarantineR.data

    const quarantineProjects: ProjectDirectory[] = []
    if (quarantineDirectory !== undefined) {
      const quarantineEntriesR = await directoryEntriesRead(
        quarantineDirectory,
        posix.join(root, quarantineDirectoryName),
        budget,
      )
      if (!quarantineEntriesR.success) return quarantineEntriesR
      quarantineDevice = (await quarantineDirectory.stat()).dev
      for (const entry of quarantineEntriesR.data) {
        if (!projectIdPattern.test(entry.name) || !entry.stat.isDirectory() || entry.stat.isSymbolicLink()) continue
        if (entry.stat.dev !== quarantineDevice) continue
        quarantineProjects.push({ id: entry.name, stat: entry.stat })
      }
    }

    const entriesR = await directoryEntriesRead(projects, posix.join(root, "projects"), budget)
    if (!entriesR.success) return entriesR
    const liveProjectEntryNames = new Set<string>()
    const projectDirectories: ProjectDirectory[] = []
    for (const entry of entriesR.data) {
      if (!projectIdPattern.test(entry.name)) continue
      liveProjectEntryNames.add(entry.name)
      if (!entry.stat.isDirectory() || entry.stat.isSymbolicLink()) continue
      if (entry.stat.dev !== projectsStat.dev) continue
      projectDirectories.push({ id: entry.name, stat: entry.stat })
    }

    // A rename can be interrupted after the live directory moves and before its state is changed. Adopt only a
    // quarantine directory that still contains the verified inactive metadata carried by that live directory.
    for (const quarantinedProject of quarantineProjects) {
      if (quarantineDirectory === undefined) continue

      const crashCleanupR = await quarantineDirectoryCrashCleanup(
        quarantineDirectory,
        quarantinedProject,
        projectsStat.dev,
        budget,
        filesystem,
        !active.has(quarantinedProject.id) && !liveProjectEntryNames.has(quarantinedProject.id),
      )
      if (!crashCleanupR.success) return crashCleanupR
      if (crashCleanupR.data) continue
      if (active.has(quarantinedProject.id)) continue
      if (liveProjectEntryNames.has(quarantinedProject.id)) continue

      const directory = await projectDirectoryOpen(quarantineDirectory, quarantinedProject, projectsStat.dev)
      if (directory === undefined) continue
      try {
        const verifiedR = await projectDirectoryVerifyFlat(
          directory,
          descriptorChildPath(quarantineDirectory, quarantinedProject.id),
          budget,
        )
        if (!verifiedR.success) return verifiedR
        if (!verifiedR.data) continue
        const metadata = await metadataRead(directory)
        if (metadata.kind !== "valid" || metadata.data.state !== "inactive") continue
        if (metadata.data.inactiveAt > now || now - metadata.data.inactiveAt < retentionWindowMs) continue
        const confirmedMetadata = await metadataRead(directory)
        if (
          confirmedMetadata.kind !== "valid" ||
          confirmedMetadata.data.state !== "inactive" ||
          confirmedMetadata.data.inactiveAt !== metadata.data.inactiveAt
        ) {
          continue
        }
        const adopted = await metadataWrite(
          directory,
          {
            version: 1,
            state: "quarantined",
            inactiveAt: confirmedMetadata.data.inactiveAt,
            quarantinedAt: now,
          },
          stillCurrent,
        )
        if (!adopted) continue
      } finally {
        await fileHandleClose(directory)
      }
    }

    if (quarantineDirectory !== undefined && quarantineDevice !== undefined) {
      for (const quarantinedProject of quarantineProjects) {
        const cleanedR = await quarantineDirectoryCleanup(
          quarantineDirectory,
          quarantinedProject,
          quarantineDevice,
          budget,
          now,
          filesystem,
        )
        if (!cleanedR.success) return cleanedR
      }
    }

    for (const project of projectDirectories) {
      const directory = await projectDirectoryOpen(projects, project, projectsStat.dev)
      if (directory === undefined) continue
      let metadata: MetadataRead
      try {
        const temporaryPath = descriptorChildPath(projects, project.id)
        const temporaryCandidateR = await metadataTemporaryFileCandidateExists(directory, temporaryPath, budget)
        if (!temporaryCandidateR.success) return temporaryCandidateR
        const temporaryCleanupR = temporaryCandidateR.data
          ? await metadataTemporaryFilesCleanup(directory, temporaryPath, budget, filesystem)
          : createResult({ removed: 0, empty: false })
        if (!temporaryCleanupR.success) return temporaryCleanupR
        metadata = await metadataRead(directory)
      } finally {
        await fileHandleClose(directory)
      }
      if (active.has(project.id)) {
        if (metadata.kind !== "valid" || metadata.data.state !== "active") {
          const activeDirectory = await projectDirectoryOpen(projects, project, projectsStat.dev)
          if (activeDirectory === undefined) continue
          let activeWritten = false
          try {
            if (!stillCurrent()) continue
            activeWritten = await metadataWrite(activeDirectory, { version: 1, state: "active" }, stillCurrent)
          } finally {
            await fileHandleClose(activeDirectory)
          }
          if (!activeWritten) continue
        }
        continue
      }
      if (metadata.kind === "unavailable" || metadata.kind === "malformed") continue
      if (metadata.kind === "missing" || (metadata.kind === "valid" && metadata.data.state === "active")) {
        const inactiveDirectory = await projectDirectoryOpen(projects, project, projectsStat.dev)
        if (inactiveDirectory === undefined) continue
        let written = false
        try {
          if (!stillCurrent()) continue
          written = await metadataWrite(
            inactiveDirectory,
            { version: 1, state: "inactive", inactiveAt: now },
            stillCurrent,
          )
        } finally {
          await fileHandleClose(inactiveDirectory)
        }
        if (!written) continue
        continue
      }
      if (metadata.kind !== "valid" || metadata.data.state !== "inactive") continue
      if (metadata.data.inactiveAt > now || now - metadata.data.inactiveAt < retentionWindowMs) continue
      if (quarantineDirectory === undefined) {
        const quarantineCreateR = await quarantineDirectoryOpen(rootDirectory, projectsStat.dev, true, filesystem)
        if (!quarantineCreateR.success) return quarantineCreateR
        quarantineDirectory = quarantineCreateR.data
        if (quarantineDirectory === undefined) continue
      }
      if (!stillCurrent()) continue
      const quarantinedR = await projectDirectoryQuarantine(
        projects,
        project,
        projectsStat.dev,
        budget,
        quarantineDirectory,
        now,
        metadata.data.inactiveAt,
        stillCurrent,
        filesystem,
      )
      if (!quarantinedR.success) return quarantinedR
      if (!quarantinedR.data) continue
    }
    return createResult(true)
  } catch {
    return retentionError("retention reconciliation failed", root)
  } finally {
    await fileHandleClose(quarantineDirectory)
    await fileHandleClose(projectsDirectory)
    await fileHandleClose(rootDirectory)
  }
}

export function projectAccessLogRetentionReconcile(
  options: ProjectAccessLogRetentionReconcileOptions,
): PromiseResult<true> {
  const optionsR = retentionOptionsNormalize(options)
  if (!optionsR.success) return Promise.resolve(optionsR)

  const run = reconciliationFlight.then(async () => {
    try {
      return await projectAccessLogRetentionReconcileRun({
        ...optionsR.data,
        stillCurrent: optionsR.data.stillCurrent ?? (() => true),
      })
    } catch {
      return retentionError("retention reconciliation failed", optionsR.data.root)
    }
  })
  reconciliationFlight = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
