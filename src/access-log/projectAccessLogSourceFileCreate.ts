import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result, type ResultErr } from "#result"
import type { ProjectKey } from "../project/projectKey.js"
import type {
  ProjectAccessLogPage,
  ProjectAccessLogReadOptions,
  ProjectAccessLogRecord,
  ProjectAccessLogSource,
  ProjectAccessLogSourceError,
  ProjectAccessLogSourceErrorCode,
} from "./ProjectAccessLogSource.js"
import { projectAccessLogCaddyRetention } from "./projectAccessLogCaddyRetention.js"
import {
  type ProjectAccessLogCursorCodec,
  type ProjectAccessLogCursorPayload,
  projectAccessLogCursorCreate,
} from "./projectAccessLogCursor.js"
import { projectAccessLogId } from "./projectAccessLogId.js"
import { projectAccessLogParser } from "./projectAccessLogParser.js"
import { projectAccessLogPath } from "./projectAccessLogPath.js"
import { projectAccessLogRootSchema } from "./projectAccessLogRootSchema.js"

const defaultMaxRecords = 100
const maximumMaxRecords = 1_000
const defaultMaxLineBytes = 128 * 1024
const maximumMaxLineBytes = 1024 * 1024
const defaultMaxScannedBytes = 64 * 1024 * 1024
const maximumMaxScannedBytes = 128 * 1024 * 1024
const defaultMaxDecompressedBytes = 64 * 1024 * 1024
const maximumMaxDecompressedBytes = 128 * 1024 * 1024
const readChunkBytes = 64 * 1024
const archiveNameSchema = a.pipe(a.string(), a.regex(/^access-[A-Za-z0-9_.-]+\.jsonl(?:\.gz)?$/))
const maximumArchiveBases = projectAccessLogCaddyRetention.rollKeep
const maximumArchiveEntries = maximumArchiveBases * 2
const maximumDirectoryEntries = maximumArchiveEntries + 2 // active log plus repository-owned retention metadata
const noFollowFlag = constants.O_NOFOLLOW ?? 0
const nonBlockingFlag = constants.O_NONBLOCK ?? 0
const directoryFlag = constants.O_DIRECTORY ?? 0
const descriptorDirectoryFlags = constants.O_RDONLY | directoryFlag | noFollowFlag
const descriptorFileFlags = constants.O_RDONLY | noFollowFlag | nonBlockingFlag
const descriptorTraversalAvailable = noFollowFlag !== 0 && directoryFlag !== 0 && nonBlockingFlag !== 0

type FileHandle = Awaited<ReturnType<typeof open>>

export type ProjectAccessLogSourceLimits = {
  maxRecords?: number
  maxLineBytes?: number
  maxScannedBytes?: number
  maxDecompressedBytes?: number
}

export type ProjectAccessLogSourceFileCreateOptions = {
  root: string
  limits?: ProjectAccessLogSourceLimits
  maxRecords?: number
  maxLineBytes?: number
  maxScannedBytes?: number
  maxDecompressedBytes?: number
  cursor?: ProjectAccessLogCursorCodec
  cursorLifetimeMs?: number
  clock?: () => number
}

type Limits = {
  maxRecords: number
  maxLineBytes: number
  maxScannedBytes: number
  maxDecompressedBytes: number
}

type FileKind = "active" | "archive"
type FileEncoding = "plain" | "gzip"

type SourceFile = {
  encoding: FileEncoding
  kind: FileKind
  name: string
  path: string
  fingerprint: string
  directory: FileHandle
}

type ArchiveCandidates = {
  plain?: string
  gzip?: string
}

type ArchiveCandidateFile = {
  base: string
  encoding: FileEncoding
  name: string
}

type SourceDirectories = {
  root: FileHandle
  projects: FileHandle
  project: FileHandle
}

type SourceFiles = {
  files: readonly SourceFile[]
  directories: SourceDirectories
}

type Budget = {
  scannedBytes: number
  decompressedBytes: number
}

type ScannedRecord = {
  record: ProjectAccessLogRecord
  source: SourceFile
  line: number
  offset?: number
  anchorDigest: string
}

type FileScan = {
  records: readonly ScannedRecord[]
  malformedLines: number
}

type ScanFailure = Error & {
  code: string
}

class ScanResultError extends Error {
  readonly result: ResultErr

  constructor(result: ResultErr) {
    super(result.errorMessage)
    this.result = result
  }
}

function sourceError(
  code: ProjectAccessLogSourceErrorCode,
  message: string,
  errorData?: string,
): ProjectAccessLogSourceError {
  const result = createResultError("projectAccessLogSourceFile", message, errorData)
  return { ...result, code }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}

function limitResolve(value: number | undefined, defaultValue: number, maximumValue: number): number | undefined {
  const resolved = value ?? defaultValue
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximumValue) return undefined
  return resolved
}

function limitsResolve(options: ProjectAccessLogSourceLimits | undefined): Result<Limits> {
  const maxRecords = limitResolve(options?.maxRecords, defaultMaxRecords, maximumMaxRecords)
  const maxLineBytes = limitResolve(options?.maxLineBytes, defaultMaxLineBytes, maximumMaxLineBytes)
  const maxScannedBytes = limitResolve(options?.maxScannedBytes, defaultMaxScannedBytes, maximumMaxScannedBytes)
  const maxDecompressedBytes = limitResolve(
    options?.maxDecompressedBytes,
    defaultMaxDecompressedBytes,
    maximumMaxDecompressedBytes,
  )
  if (
    maxRecords === undefined ||
    maxLineBytes === undefined ||
    maxScannedBytes === undefined ||
    maxDecompressedBytes === undefined
  ) {
    return sourceError("access-log.invalid-input", "access log source limits are invalid")
  }
  return createResult({ maxRecords, maxLineBytes, maxScannedBytes, maxDecompressedBytes })
}

function statFingerprint(stat: import("node:fs").Stats, kind: FileKind): string {
  if (kind === "active") return `active:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
  return `archive:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`
}

function statIsRegular(stat: import("node:fs").Stats): boolean {
  return stat.isFile()
}

function archiveCandidateFileCompare(left: ArchiveCandidateFile, right: ArchiveCandidateFile): number {
  // Caddy roll names are ASCII; relational comparison is locale-independent.
  if (left.base !== right.base) return left.base < right.base ? 1 : -1
  if (left.encoding === right.encoding) return 0
  return left.encoding === "plain" ? -1 : 1
}

function descriptorChildPath(directory: FileHandle, name: string): string {
  // The proc descriptor link anchors resolution to the already-open directory; no configured pathname is reopened.
  return `/proc/self/fd/${directory.fd}/${name}`
}

async function fileHandleClose(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return
  try {
    await handle.close()
  } catch {
    // The read result is already determined; a close failure must not leak an exception.
  }
}

async function sourceDirectoriesClose(directories: SourceDirectories): Promise<void> {
  await fileHandleClose(directories.project)
  await fileHandleClose(directories.projects)
  await fileHandleClose(directories.root)
}

async function directoryOpenRelative(
  parent: FileHandle,
  name: string,
  path: string,
): Promise<Result<FileHandle | undefined>> {
  if (!descriptorTraversalAvailable)
    return sourceError("access-log.storage-unavailable", "descriptor-relative access is unavailable", path)
  try {
    return createResult(await open(descriptorChildPath(parent, name), descriptorDirectoryFlags))
  } catch (error) {
    if (errorCode(error) === "ENOENT") return createResult(undefined)
    if (errorCode(error) === "ELOOP")
      return sourceError("access-log.symlink", "access log path is a symbolic link", path)
    if (errorCode(error) === "ENOTDIR") {
      try {
        if ((await lstat(descriptorChildPath(parent, name))).isSymbolicLink())
          return sourceError("access-log.symlink", "access log path is a symbolic link", path)
      } catch {
        // The failed open already prevents access; retain the safe non-directory result if classification races.
      }
      return sourceError("access-log.non-regular-file", "access log path is not a directory", path)
    }
    return sourceError("access-log.storage-unavailable", "access log directory could not be opened", path)
  }
}

async function rootDirectoryOpen(root: string): Promise<Result<FileHandle | undefined>> {
  if (!descriptorTraversalAvailable)
    return sourceError("access-log.storage-unavailable", "descriptor-relative access is unavailable", root)
  let current: FileHandle | undefined
  let retained = false
  let currentPath = "/"
  try {
    current = await open("/", descriptorDirectoryFlags)
    for (const part of root.split("/").filter((value) => value.length > 0)) {
      const nextR = await directoryOpenRelative(current, part, join(currentPath, part))
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
    if (errorCode(error) === "ELOOP")
      return sourceError("access-log.symlink", "access log path is a symbolic link", root)
    if (errorCode(error) === "ENOTDIR")
      return sourceError("access-log.non-regular-file", "access log path is not a directory", root)
    return sourceError("access-log.storage-unavailable", "access log directory could not be opened", root)
  } finally {
    if (!retained) await fileHandleClose(current)
  }
}

async function sourceFileMetadataResolve(
  directory: FileHandle,
  kind: FileKind,
  encoding: FileEncoding,
  name: string,
  path: string,
): Promise<Result<SourceFile | undefined>> {
  let handle: FileHandle | undefined
  try {
    const listedStat = await lstat(descriptorChildPath(directory, name))
    if (listedStat.isSymbolicLink()) return sourceError("access-log.symlink", "access log is a symbolic link", path)
    if (!statIsRegular(listedStat)) {
      return sourceError(
        "access-log.non-regular-file",
        kind === "active" ? "active access log is not a regular file" : "access log archive is not a regular file",
        path,
      )
    }
    handle = await open(descriptorChildPath(directory, name), descriptorFileFlags)
    const stat = await handle.stat()
    if (!statIsRegular(stat)) {
      return sourceError(
        "access-log.non-regular-file",
        kind === "active" ? "active access log is not a regular file" : "access log archive is not a regular file",
        path,
      )
    }
    return createResult({ encoding, kind, name, path, fingerprint: statFingerprint(stat, kind), directory })
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      if (kind === "archive")
        return sourceError("access-log.rotation-race", "access log changed while being listed", path)
      return createResult(undefined)
    }
    if (errorCode(error) === "ELOOP") return sourceError("access-log.symlink", "access log is a symbolic link", path)
    return sourceError("access-log.storage-unavailable", "access log could not be inspected", path)
  } finally {
    await fileHandleClose(handle)
  }
}

async function sourceFileOpen(sourceFile: SourceFile): Promise<Result<FileHandle>> {
  try {
    return createResult(await open(descriptorChildPath(sourceFile.directory, sourceFile.name), descriptorFileFlags))
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
    if (errorCode(error) === "ELOOP")
      return sourceError("access-log.symlink", "access log is a symbolic link", sourceFile.path)
    return sourceError("access-log.storage-unavailable", "access log could not be opened", sourceFile.path)
  }
}

async function sourceFileCurrentStat(sourceFile: SourceFile): Promise<Result<import("node:fs").Stats | undefined>> {
  try {
    return createResult(await lstat(descriptorChildPath(sourceFile.directory, sourceFile.name)))
  } catch (error) {
    if (errorCode(error) === "ENOENT") return createResult(undefined)
    return sourceError("access-log.storage-unavailable", "access log could not be inspected", sourceFile.path)
  }
}

async function sourceFilesResolve(root: string, project: ProjectKey): Promise<Result<SourceFiles | undefined>> {
  const activePathR = projectAccessLogPath(root, project)
  if (!activePathR.success) return sourceError("access-log.invalid-input", activePathR.errorMessage)
  const projectDirectory = dirname(activePathR.data)
  const projectsDirectory = dirname(projectDirectory)

  const rootR = await rootDirectoryOpen(root)
  if (!rootR.success) return rootR
  if (rootR.data === undefined) return createResult(undefined)
  const rootDirectory = rootR.data

  const projectsR = await directoryOpenRelative(rootDirectory, basename(projectsDirectory), projectsDirectory)
  if (!projectsR.success) {
    await fileHandleClose(rootDirectory)
    return projectsR
  }
  if (projectsR.data === undefined) {
    await fileHandleClose(rootDirectory)
    return createResult(undefined)
  }
  const projectsHandle = projectsR.data

  const projectR = await directoryOpenRelative(projectsHandle, basename(projectDirectory), projectDirectory)
  if (!projectR.success) {
    await fileHandleClose(projectsHandle)
    await fileHandleClose(rootDirectory)
    return projectR
  }
  if (projectR.data === undefined) {
    await fileHandleClose(projectsHandle)
    await fileHandleClose(rootDirectory)
    return createResult(undefined)
  }

  const directories: SourceDirectories = { root: rootDirectory, projects: projectsHandle, project: projectR.data }
  let retained = false
  try {
    const files: SourceFile[] = []
    const activeR = await sourceFileMetadataResolve(
      directories.project,
      "active",
      "plain",
      "access.jsonl",
      activePathR.data,
    )
    if (!activeR.success) return activeR
    if (activeR.data !== undefined) files.push(activeR.data)

    let entriesDirectory: Awaited<ReturnType<typeof opendir>> | undefined
    try {
      entriesDirectory = await opendir(descriptorChildPath(directories.project, "."))
    } catch {
      return sourceError("access-log.storage-unavailable", "access log directory could not be read", projectDirectory)
    }
    const archiveCandidates = new Map<string, ArchiveCandidates>()
    let directoryEntryCount = 0
    let archiveEntryCount = 0
    try {
      for await (const entry of entriesDirectory) {
        directoryEntryCount += 1
        if (directoryEntryCount > maximumDirectoryEntries) {
          return sourceError("access-log.resource-limit", "access log directory entry limit exceeded", projectDirectory)
        }
        if (!a.safeParse(archiveNameSchema, entry.name).success) continue
        archiveEntryCount += 1
        if (archiveEntryCount > maximumArchiveEntries) {
          return sourceError("access-log.resource-limit", "access log archive limit exceeded", projectDirectory)
        }
        const archiveBase = entry.name.endsWith(".gz") ? entry.name.slice(0, -3) : entry.name
        const candidate = archiveCandidates.get(archiveBase) ?? {}
        if (entry.name.endsWith(".gz")) candidate.gzip = entry.name
        else candidate.plain = entry.name
        if (!archiveCandidates.has(archiveBase) && archiveCandidates.size >= maximumArchiveBases) {
          return sourceError(
            "access-log.resource-limit",
            "access log archive retention limit exceeded",
            projectDirectory,
          )
        }
        archiveCandidates.set(archiveBase, candidate)
      }
    } catch {
      return sourceError("access-log.storage-unavailable", "access log directory could not be read", projectDirectory)
    } finally {
      try {
        await entriesDirectory.close()
      } catch {
        // The read result is already determined; a close failure must not leak an exception.
      }
    }
    const archiveFiles = [...archiveCandidates.entries()]
      .flatMap(([base, candidate]) => [
        ...(candidate.plain === undefined ? [] : [{ base, encoding: "plain" as const, name: candidate.plain }]),
        ...(candidate.gzip === undefined ? [] : [{ base, encoding: "gzip" as const, name: candidate.gzip }]),
      ])
      .sort(archiveCandidateFileCompare)
    for (let archiveIndex = 0; archiveIndex < archiveFiles.length; ) {
      const archiveCandidate = archiveFiles[archiveIndex]
      if (archiveCandidate === undefined) {
        archiveIndex += 1
        continue
      }
      const archiveBase = archiveCandidate.base
      let plain: SourceFile | undefined
      let gzip: SourceFile | undefined
      while (archiveIndex < archiveFiles.length) {
        const candidate = archiveFiles[archiveIndex]
        if (candidate === undefined || candidate.base !== archiveBase) break
        const path = join(projectDirectory, candidate.name)
        const archiveR = await sourceFileMetadataResolve(
          directories.project,
          "archive",
          candidate.encoding,
          candidate.name,
          path,
        )
        if (!archiveR.success) return archiveR
        if (archiveR.data === undefined)
          return sourceError("access-log.rotation-race", "access log changed while being listed", path)
        if (candidate.encoding === "plain") plain = archiveR.data
        else gzip = archiveR.data
        archiveIndex += 1
      }
      // Prefer the plain file while Caddy is transitioning an archive to gzip.
      const archive = plain ?? gzip
      if (archive !== undefined) files.push(archive)
    }
    retained = true
    return createResult({ files, directories })
  } finally {
    if (!retained) await sourceDirectoriesClose(directories)
  }
}

function lineDigest(line: Uint8Array): string {
  return createHash("sha256").update(line).digest("hex")
}

function linePartsAppend(
  parts: Uint8Array[],
  currentLength: number,
  part: Uint8Array,
  maximumLineBytes: number,
): Result<number> {
  const nextLength = currentLength + part.length
  if (nextLength > maximumLineBytes + 1) return sourceError("access-log.resource-limit", "access log line is too large")
  if (part.length > 0) parts.push(part)
  return createResult(nextLength)
}

function lineDataResolve(
  parts: readonly Uint8Array[],
  reverse: boolean,
  currentLength: number,
  maximumLineBytes: number,
): Result<Uint8Array> {
  if (currentLength === 0) return createResult(new Uint8Array())
  const data =
    parts.length === 1
      ? (parts[0] as Uint8Array)
      : (() => {
          const value = Buffer.allocUnsafe(currentLength)
          let offset = 0
          const indexes = reverse
            ? Array.from({ length: parts.length }, (_, index) => parts.length - index - 1)
            : Array.from({ length: parts.length }, (_, index) => index)
          for (const index of indexes) {
            const part = parts[index]
            if (part === undefined) continue
            value.set(part, offset)
            offset += part.length
          }
          return value
        })()
  const end = data.length > 0 && data[data.length - 1] === 0x0d ? data.length - 1 : data.length
  if (end > maximumLineBytes) return sourceError("access-log.resource-limit", "access log line is too large")
  return createResult(data.subarray(0, end))
}

function scanFailureCreate(code: string, message: string): ScanFailure {
  const error = new Error(message) as ScanFailure
  error.code = code
  return error
}

async function sourceFileFinalVerify(sourceFile: SourceFile): Promise<Result<undefined>> {
  const finalStatR = await sourceFileCurrentStat(sourceFile)
  if (!finalStatR.success) return finalStatR
  if (finalStatR.data === undefined || finalStatR.data.isSymbolicLink()) {
    return finalStatR.data?.isSymbolicLink()
      ? sourceError("access-log.symlink", "access log became a symbolic link", sourceFile.path)
      : sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
  }
  if (!statIsRegular(finalStatR.data))
    return sourceError("access-log.non-regular-file", "access log is not a regular file", sourceFile.path)
  if (statFingerprint(finalStatR.data, sourceFile.kind) !== sourceFile.fingerprint)
    return sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
  return createResult(undefined)
}

async function activeFileScan(
  sourceFile: SourceFile,
  limits: Limits,
  budget: Budget,
  capacity: number,
  before: ProjectAccessLogCursorPayload | undefined,
): Promise<Result<FileScan>> {
  let handle: FileHandle | undefined
  try {
    const handleR = await sourceFileOpen(sourceFile)
    if (!handleR.success) return handleR
    handle = handleR.data
    const openedStat = await handle.stat()
    if (!statIsRegular(openedStat))
      return sourceError("access-log.non-regular-file", "access log is not a regular file", sourceFile.path)
    if (statFingerprint(openedStat, sourceFile.kind) !== sourceFile.fingerprint) {
      return sourceError("access-log.rotation-race", "access log changed while being opened", sourceFile.path)
    }

    const records: ScannedRecord[] = []
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let malformedLines = 0
    let lineRank = 0
    let anchorSeen = before === undefined
    let anchorFailure: ProjectAccessLogSourceError | undefined
    let stop = false
    let lineEnd: number | "eof" | undefined
    let lineEndOffset = openedStat.size
    let lineParts: Uint8Array[] = []
    let lineLength = 0
    let position = 0

    const processLine = (line: Uint8Array, offset: number): Result<boolean> => {
      const currentLine = lineRank
      lineRank += 1
      if (before !== undefined && before.offset !== undefined && offset > before.offset) return createResult(false)

      const digest = lineDigest(line)
      if (before !== undefined && before.offset !== undefined && offset === before.offset) {
        if (digest !== before.anchorDigest) {
          anchorFailure = sourceError("access-log.cursor-expired", "access log cursor line has expired")
          return createResult(true)
        }
        let lineValue: string
        try {
          lineValue = decoder.decode(line)
        } catch {
          anchorFailure = sourceError("access-log.cursor-expired", "access log cursor line has expired")
          return createResult(true)
        }
        if (!projectAccessLogParser(lineValue).success) {
          anchorFailure = sourceError("access-log.cursor-expired", "access log cursor line has expired")
          return createResult(true)
        }
        anchorSeen = true
        return createResult(false)
      }

      let lineValue: string
      try {
        lineValue = decoder.decode(line)
      } catch {
        malformedLines += 1
        return createResult(false)
      }
      const parsedR = projectAccessLogParser(lineValue)
      if (!parsedR.success) {
        malformedLines += 1
        return createResult(false)
      }
      records.push({ record: parsedR.data, source: sourceFile, line: currentLine, offset, anchorDigest: digest })
      return createResult(records.length >= capacity)
    }

    while (position < openedStat.size && !stop) {
      const remaining = limits.maxScannedBytes - budget.scannedBytes
      if (remaining <= 0)
        return sourceError("access-log.resource-limit", "access log scanned-byte limit exceeded", sourceFile.path)
      const chunkEnd = openedStat.size - position
      const size = Math.min(readChunkBytes, chunkEnd, remaining)
      const start = openedStat.size - position - size
      const chunk = Buffer.allocUnsafe(size)
      const readR = await handle.read(chunk, 0, size, start)
      if (readR.bytesRead === 0)
        return sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
      if (readR.bytesRead !== size)
        return sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
      budget.scannedBytes += readR.bytesRead
      position += readR.bytesRead

      if (position === readR.bytesRead && chunk[chunk.length - 1] !== 0x0a) lineEnd = "eof"
      let index = chunk.length
      while (index > 0 && !stop) {
        let lineBreak = index - 1
        while (lineBreak >= 0 && chunk[lineBreak] !== 0x0a) lineBreak -= 1
        const appendR = linePartsAppend(
          lineParts,
          lineLength,
          chunk.subarray(lineBreak + 1, index),
          limits.maxLineBytes,
        )
        if (!appendR.success) return appendR
        lineLength = appendR.data
        if (lineBreak < 0) {
          index = 0
          break
        }

        if (lineEnd === undefined) {
          lineParts = []
          lineLength = 0
        } else {
          const lineR = lineDataResolve(lineParts, true, lineLength, limits.maxLineBytes)
          if (!lineR.success) return lineR
          const processR = processLine(lineR.data, lineEndOffset - lineLength)
          if (!processR.success) return processR
          stop = processR.data
          lineParts = []
          lineLength = 0
        }
        lineEnd = openedStat.size - position + lineBreak
        lineEndOffset = lineEnd
        index = lineBreak
      }
      if (!stop) {
        const appendR = linePartsAppend(lineParts, lineLength, chunk.subarray(0, index), limits.maxLineBytes)
        if (!appendR.success) return appendR
        lineLength = appendR.data
      }
    }

    if (!stop && lineEnd !== undefined) {
      const lineR = lineDataResolve(lineParts, true, lineLength, limits.maxLineBytes)
      if (!lineR.success) return lineR
      const processR = processLine(lineR.data, lineEndOffset - lineLength)
      if (!processR.success) return processR
      stop = processR.data
    }

    const finalR = await sourceFileFinalVerify(sourceFile)
    if (!finalR.success) return finalR
    if (anchorFailure !== undefined) return anchorFailure
    if (before !== undefined && !anchorSeen)
      return sourceError("access-log.cursor-expired", "access log cursor line has expired")
    return createResult({ records, malformedLines })
  } catch (error) {
    if (errorCode(error) === "ELOOP")
      return sourceError("access-log.symlink", "access log is a symbolic link", sourceFile.path)
    if (errorCode(error) === "ENOENT")
      return sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
    return sourceError("access-log.storage-unavailable", "access log could not be read", sourceFile.path)
  } finally {
    await fileHandleClose(handle)
  }
}

async function* sourceFileChunkIterator(
  handle: FileHandle,
  size: number,
  limits: Limits,
  budget: Budget,
): AsyncGenerator<Buffer> {
  let position = 0
  while (position < size) {
    const remaining = limits.maxScannedBytes - budget.scannedBytes
    if (remaining <= 0) throw scanFailureCreate("access-log.resource-limit", "access log scanned-byte limit exceeded")
    const readSize = Math.min(readChunkBytes, size - position, remaining)
    const chunk = Buffer.allocUnsafe(readSize)
    const readR = await handle.read(chunk, 0, readSize, position)
    if (readR.bytesRead === 0)
      throw scanFailureCreate("access-log.rotation-race", "access log changed while being read")
    budget.scannedBytes += readR.bytesRead
    position += readR.bytesRead
    yield chunk.subarray(0, readR.bytesRead)
  }
}

async function archiveFileScan(
  sourceFile: SourceFile,
  limits: Limits,
  budget: Budget,
  capacity: number,
  before: ProjectAccessLogCursorPayload | undefined,
): Promise<Result<FileScan>> {
  if (sourceFile.encoding === "gzip" && budget.decompressedBytes >= limits.maxDecompressedBytes) {
    return sourceError("access-log.resource-limit", "access log decompressed-byte limit exceeded", sourceFile.path)
  }

  let handle: FileHandle | undefined
  try {
    const handleR = await sourceFileOpen(sourceFile)
    if (!handleR.success) return handleR
    handle = handleR.data
    const openedStat = await handle.stat()
    if (!statIsRegular(openedStat))
      return sourceError("access-log.non-regular-file", "access log is not a regular file", sourceFile.path)
    if (statFingerprint(openedStat, sourceFile.kind) !== sourceFile.fingerprint) {
      return sourceError("access-log.rotation-race", "access log changed while being opened", sourceFile.path)
    }

    const records: ScannedRecord[] = []
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let malformedLines = 0
    let lineIndex = 0
    let anchorSeen = before === undefined
    let anchorFailure: ProjectAccessLogSourceError | undefined
    let stop = false
    let lineParts: Uint8Array[] = []
    let lineLength = 0
    const processLine = (line: Uint8Array): boolean => {
      const currentLine = lineIndex
      lineIndex += 1
      if (before !== undefined && currentLine > before.line) return false
      const digest = lineDigest(line)
      if (before !== undefined && currentLine === before.line) {
        if (digest !== before.anchorDigest) {
          anchorFailure = sourceError("access-log.cursor-expired", "access log cursor line has expired")
          return true
        }
        let lineValue: string
        try {
          lineValue = decoder.decode(line)
        } catch {
          anchorFailure = sourceError("access-log.cursor-expired", "access log cursor line has expired")
          return true
        }
        if (!projectAccessLogParser(lineValue).success) {
          anchorFailure = sourceError("access-log.cursor-expired", "access log cursor line has expired")
          return true
        }
        anchorSeen = true
        return true
      }
      let lineValue: string
      try {
        lineValue = decoder.decode(line)
      } catch {
        malformedLines += 1
        return false
      }
      const parsedR = projectAccessLogParser(lineValue)
      if (!parsedR.success) {
        malformedLines += 1
        return false
      }
      if (records.length >= capacity) records.shift()
      records.push({ record: parsedR.data, source: sourceFile, line: currentLine, anchorDigest: digest })
      return false
    }

    const source = Readable.from(sourceFileChunkIterator(handle, openedStat.size, limits, budget))
    const gunzip = sourceFile.encoding === "gzip" ? createGunzip({ chunkSize: readChunkBytes }) : undefined
    const decompressed = gunzip === undefined ? source : source.pipe(gunzip)
    try {
      for await (const chunk of decompressed) {
        if (sourceFile.encoding === "gzip") {
          budget.decompressedBytes += chunk.length
          if (budget.decompressedBytes > limits.maxDecompressedBytes)
            throw new ScanResultError(
              sourceError("access-log.resource-limit", "access log decompressed-byte limit exceeded", sourceFile.path),
            )
        }
        let index = 0
        while (index < chunk.length) {
          const lineBreak = chunk.indexOf(0x0a, index)
          const end = lineBreak < 0 ? chunk.length : lineBreak
          const appendR = linePartsAppend(lineParts, lineLength, chunk.subarray(index, end), limits.maxLineBytes)
          if (!appendR.success) throw new ScanResultError(appendR)
          lineLength = appendR.data
          if (lineBreak < 0) break
          const lineR = lineDataResolve(lineParts, false, lineLength, limits.maxLineBytes)
          if (!lineR.success) throw new ScanResultError(lineR)
          stop = processLine(lineR.data)
          lineParts = []
          lineLength = 0
          index = lineBreak + 1
          if (stop) break
        }
        if (stop) break
      }
    } catch (error) {
      if (error instanceof ScanResultError) return error.result
      if (errorCode(error) === "access-log.resource-limit")
        return sourceError("access-log.resource-limit", "access log scanned-byte limit exceeded", sourceFile.path)
      if (errorCode(error) === "access-log.rotation-race")
        return sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
      if (errorCode(error) === "ELOOP")
        return sourceError("access-log.symlink", "access log is a symbolic link", sourceFile.path)
      return sourceError(
        "access-log.storage-unavailable",
        "access log archive could not be decompressed",
        sourceFile.path,
      )
    } finally {
      source.destroy()
      gunzip?.destroy()
    }

    if (lineLength > 0) {
      const lineR = lineDataResolve(lineParts, false, lineLength, limits.maxLineBytes)
      if (!lineR.success) return lineR
      processLine(lineR.data)
    }
    const finalR = await sourceFileFinalVerify(sourceFile)
    if (!finalR.success) return finalR
    if (anchorFailure !== undefined) return anchorFailure
    if (before !== undefined && !anchorSeen)
      return sourceError("access-log.cursor-expired", "access log cursor line has expired")
    return createResult({ records, malformedLines })
  } catch (error) {
    if (errorCode(error) === "ELOOP")
      return sourceError("access-log.symlink", "access log is a symbolic link", sourceFile.path)
    if (errorCode(error) === "ENOENT")
      return sourceError("access-log.rotation-race", "access log changed while being read", sourceFile.path)
    return sourceError("access-log.storage-unavailable", "access log could not be read", sourceFile.path)
  } finally {
    await fileHandleClose(handle)
  }
}

function readOptionsValidate(
  options: ProjectAccessLogReadOptions | undefined,
  maxRecords: number,
): Result<{ limit: number; before?: string }> {
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    return sourceError("access-log.invalid-input", "access log read options are invalid")
  }
  const limit = options?.limit ?? maxRecords
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRecords) {
    return sourceError("access-log.invalid-input", "access log limit is invalid")
  }
  if (options?.before !== undefined && (typeof options.before !== "string" || options.before.length > 4096)) {
    return sourceError("access-log.invalid-input", "access log cursor is invalid")
  }
  return createResult({ limit, before: options?.before })
}

function projectKeyValidate(project: unknown): project is ProjectKey {
  try {
    return (
      typeof project === "object" &&
      project !== null &&
      !Array.isArray(project) &&
      typeof (project as { owner?: unknown }).owner === "string" &&
      (project as { owner: string }).owner.length > 0 &&
      typeof (project as { name?: unknown }).name === "string" &&
      (project as { name: string }).name.length > 0
    )
  } catch {
    return false
  }
}

function cursorFailure(result: Result<ProjectAccessLogCursorPayload>): ProjectAccessLogSourceError {
  if (result.success) return sourceError("access-log.invalid-cursor", "access log cursor is invalid")
  if (result.code === "access-log.cursor-expired") return sourceError("access-log.cursor-expired", result.errorMessage)
  return sourceError("access-log.invalid-cursor", result.errorMessage)
}

export function projectAccessLogSourceFileCreate(
  options: ProjectAccessLogSourceFileCreateOptions | string,
): Result<ProjectAccessLogSource> {
  const normalizedOptions = typeof options === "string" ? { root: options } : options
  if (
    typeof normalizedOptions !== "object" ||
    normalizedOptions === null ||
    typeof normalizedOptions.root !== "string"
  ) {
    return sourceError("access-log.invalid-input", "access log source options are invalid")
  }
  const rootR = a.safeParse(projectAccessLogRootSchema, normalizedOptions.root)
  if (!rootR.success) return sourceError("access-log.invalid-input", a.summarize(rootR.issues))
  const limitsR = limitsResolve(
    normalizedOptions.limits ?? {
      maxRecords: normalizedOptions.maxRecords,
      maxLineBytes: normalizedOptions.maxLineBytes,
      maxScannedBytes: normalizedOptions.maxScannedBytes,
      maxDecompressedBytes: normalizedOptions.maxDecompressedBytes,
    },
  )
  if (!limitsR.success) return limitsR
  const cursor =
    normalizedOptions.cursor ??
    projectAccessLogCursorCreate({
      clock: normalizedOptions.clock,
      lifetimeMs: normalizedOptions.cursorLifetimeMs,
    })
  const root = rootR.output
  const limits = limitsR.data

  const source: ProjectAccessLogSource = {
    async read(project, options = {}): PromiseResult<ProjectAccessLogPage> {
      if (!projectKeyValidate(project)) return sourceError("access-log.invalid-input", "access log project is invalid")
      const readOptionsR = readOptionsValidate(options, limits.maxRecords)
      if (!readOptionsR.success) return readOptionsR
      const cursorR =
        readOptionsR.data.before === undefined ? createResult(undefined) : cursor.decode(readOptionsR.data.before)
      if (!cursorR.success) return cursorFailure(cursorR)
      const projectId = projectAccessLogId(project)
      if (cursorR.data !== undefined && cursorR.data.projectId !== projectId) {
        return sourceError("access-log.invalid-cursor", "access log cursor does not belong to this project")
      }
      if (cursorR.data !== undefined && cursorR.data.anchorDigest === undefined) {
        return sourceError("access-log.cursor-expired", "access log cursor anchor has expired")
      }
      const filesR = await sourceFilesResolve(root, project)
      if (!filesR.success) return filesR
      if (filesR.data === undefined)
        return createResult({ records: [], next: undefined, partial: false, malformedLines: 0 })
      const files = filesR.data.files
      try {
        const before = cursorR.data
        let beforeIndex = -1
        if (before !== undefined) {
          beforeIndex = files.findIndex((file) => file.name === before.source)
          if (beforeIndex < 0) return sourceError("access-log.cursor-expired", "access log cursor source has expired")
          if (files[beforeIndex]?.fingerprint !== before.sourceFingerprint) {
            return sourceError("access-log.cursor-expired", "access log cursor source has expired")
          }
          if (files[beforeIndex]?.kind === "active" && before.offset === undefined) {
            return sourceError("access-log.cursor-expired", "access log cursor offset has expired")
          }
        }

        const budget: Budget = { scannedBytes: 0, decompressedBytes: 0 }
        const records: ScannedRecord[] = []
        let malformedLines = 0
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
          const file = files[fileIndex]
          if (file === undefined) continue
          if (before !== undefined && fileIndex < beforeIndex) continue
          const capacity = readOptionsR.data.limit + 1 - records.length
          if (capacity <= 0) break
          const fileBefore = before !== undefined && fileIndex === beforeIndex ? before : undefined
          const scanR =
            file.kind === "active"
              ? await activeFileScan(file, limits, budget, capacity, fileBefore)
              : await archiveFileScan(file, limits, budget, capacity, fileBefore)
          if (!scanR.success) return scanR
          malformedLines += scanR.data.malformedLines
          const scannedRecords = file.kind === "archive" ? [...scanR.data.records].reverse() : scanR.data.records
          for (const scannedRecord of scannedRecords) {
            if (records.length >= readOptionsR.data.limit + 1) break
            records.push(scannedRecord)
          }
          if (records.length >= readOptionsR.data.limit + 1) break
        }
        let next: string | undefined
        if (records.length > readOptionsR.data.limit) {
          const nextAnchor = records[readOptionsR.data.limit - 1]
          if (nextAnchor === undefined)
            return sourceError("access-log.invalid-input", "access log cursor anchor is invalid")
          const nextR = cursor.encode({
            anchorDigest: nextAnchor.anchorDigest,
            projectId,
            source: nextAnchor.source.name,
            sourceFingerprint: nextAnchor.source.fingerprint,
            line: nextAnchor.line,
            ...(nextAnchor.offset === undefined ? {} : { offset: nextAnchor.offset }),
          })
          if (!nextR.success) return sourceError("access-log.invalid-input", nextR.errorMessage)
          next = nextR.data
        }
        return createResult({
          records: records.slice(0, readOptionsR.data.limit).map((scannedRecord) => scannedRecord.record),
          next,
          partial: malformedLines > 0,
          malformedLines,
        })
      } finally {
        await sourceDirectoriesClose(filesR.data.directories)
      }
    },
  }
  return createResult(source)
}
