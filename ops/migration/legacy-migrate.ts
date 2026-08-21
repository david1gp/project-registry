#!/usr/bin/env bun

import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import { createResult, createResultError, type PromiseResult, type Result } from "@adaptive-ds/result"
import * as a from "valibot"
import { projectCollisions } from "../../src/project/projectCollisions.ts"
import { projectDomainNormalize } from "../../src/project/projectDomainNormalize.ts"
import { type Project, projectSchema } from "../../src/project/projectSchema.ts"

const migrationMarkerPath = "migrations/legacy-v1.json"
const projectNamePattern = /^[a-z0-9][a-z0-9-]*$/
const serviceNamePattern = /^[A-Za-z0-9_.@:-]+(?:\.service)?$/
const caddyFields = new Set([
  "port",
  "domains",
  "name",
  "path",
  "user",
  "access",
  "kind",
  "docs",
  "browse",
  "headerUp",
  "shared",
  "template",
  "disabled",
  "routed",
  "oidcPaths",
  "docsPath",
  "browseTemplate",
  "staticAllow",
  "denyDotfiles",
  "spa",
  "flushInterval",
])
const softwareFields = new Set([
  "github",
  "order",
  "preview_port",
  "preview_url",
  "production_url",
  "production_assets_url",
  "services",
  "type",
])

type MigrationOptions = {
  apply: boolean
  json: boolean
  destinationRepository?: string
  nameMappingPath?: string
  repository: string
  softwareOwner?: string
  softwareProjectsPath?: string
}

type MigrationArguments = { help: true } | { help: false; options: MigrationOptions }

type MigrationProjectEntry = {
  path: string
  project: Project
}

type MigrationSoftwareEntry = {
  file: string
  project: Project
}

type MigrationGitState = {
  branch: string
  configEntries: string[]
  remotes: string[]
  revision: string
  upstream: { ref: string; remote: string } | null
}

type MigrationRepositoryContext = {
  markerPath: string
  repository: string
  state: MigrationGitState
}

type MigrationDestinationContext = {
  marker?: MigrationMarker
  repository: string
  state?: MigrationGitState
}

type MigrationMarker = {
  migration: "legacy-v1"
  projectCount: number
  projectPaths: string[]
  schemaVersion: 1
  sourceBranch: string
  sourceRemotes: string[]
  sourceRepository: string
  sourceRevision: string
  sourceUpstream: { ref: string; remote: string } | null
  softwareOwner: string | null
  softwareProjectFiles: string[]
  softwareProjects: string | null
}

type MigrationPlan = {
  marker: MigrationMarker
  records: MigrationProjectEntry[]
  sharedConversions: string[]
}

type MigrationCompleted = {
  commit: string
}

type MigrationReport = {
  completed?: MigrationCompleted
  destinationRepository: string | null
  marker: MigrationMarker
  mode: "apply" | "dry-run"
  records: MigrationProjectEntry[]
  sharedConversions: string[]
}

function migrationStringCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function migrationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function migrationRecordValue(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

function migrationMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function migrationText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text === "" ? undefined : text
}

function migrationProjectKey(owner: string, name: string): string {
  return `${owner}\u0000${name}`
}

function migrationPathSegmentSafe(value: string): boolean {
  if (value === "" || value === "." || value === ".." || value === ".git") return false
  if (/[\\/]/.test(value)) return false
  return ![...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code < 32 || code === 127)
  })
}

function migrationArgumentValue(args: string[], index: number, option: string): Result<string> {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--"))
    return createResultError("migrationArgumentsParse", `${option} needs a value`)
  return createResult(value)
}

function migrationArgumentsParse(args: readonly string[]): Result<MigrationArguments> {
  const options: Partial<MigrationOptions> = { apply: false, json: false }
  let applyFlag = false
  let dryRunFlag = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--help" || argument === "-h") return createResult({ help: true })
    if (argument === "--apply") {
      applyFlag = true
      continue
    }
    if (argument === "--dry-run") {
      dryRunFlag = true
      continue
    }
    if (argument === "--json") {
      options.json = true
      continue
    }

    const valueOption = [
      "--repository",
      "--destination-repository",
      "--software-projects",
      "--software-owner",
      "--name-mapping",
    ].find((option) => argument === option)
    if (valueOption !== undefined) {
      const valueR = migrationArgumentValue([...args], index, valueOption)
      if (!valueR.success) return valueR
      index += 1
      if (valueOption === "--repository") options.repository = valueR.data
      if (valueOption === "--destination-repository") options.destinationRepository = valueR.data
      if (valueOption === "--software-projects") options.softwareProjectsPath = valueR.data
      if (valueOption === "--software-owner") options.softwareOwner = valueR.data
      if (valueOption === "--name-mapping") options.nameMappingPath = valueR.data
      continue
    }

    return createResultError("migrationArgumentsParse", `unknown argument: ${argument}`)
  }

  if (applyFlag && dryRunFlag)
    return createResultError("migrationArgumentsParse", "--apply and --dry-run are mutually exclusive")
  if (options.repository === undefined || options.repository.trim() === "") {
    return createResultError("migrationArgumentsParse", "--repository is required")
  }
  if (options.softwareProjectsPath !== undefined && options.softwareOwner?.trim() === "") {
    return createResultError("migrationArgumentsParse", "--software-owner is required with --software-projects")
  }
  if (options.softwareProjectsPath === undefined && options.softwareOwner !== undefined) {
    return createResultError("migrationArgumentsParse", "--software-owner requires --software-projects")
  }
  if (applyFlag && (options.destinationRepository === undefined || options.destinationRepository.trim() === "")) {
    return createResultError("migrationArgumentsParse", "--destination-repository is required with --apply")
  }

  return createResult({
    help: false,
    options: {
      apply: applyFlag,
      ...(options.destinationRepository === undefined ? {} : { destinationRepository: options.destinationRepository }),
      json: options.json ?? false,
      ...(options.nameMappingPath === undefined ? {} : { nameMappingPath: options.nameMappingPath }),
      repository: options.repository,
      ...(options.softwareOwner === undefined ? {} : { softwareOwner: options.softwareOwner }),
      ...(options.softwareProjectsPath === undefined ? {} : { softwareProjectsPath: options.softwareProjectsPath }),
    },
  })
}

async function migrationGitRun(repository: string, args: string[], migrationIdentity = false): PromiseResult<string> {
  const op = "migrationGitRun"
  try {
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(Bun.env)) {
      if (value !== undefined) environment[key] = value
    }
    environment.GIT_OPTIONAL_LOCKS = "0"
    if (migrationIdentity) {
      environment.GIT_AUTHOR_EMAIL = "project-registry@localhost"
      environment.GIT_AUTHOR_NAME = "project-registry"
      environment.GIT_COMMITTER_EMAIL = "project-registry@localhost"
      environment.GIT_COMMITTER_NAME = "project-registry"
    }

    const process = Bun.spawn(["git", "-C", repository, ...args], {
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (exitCode !== 0)
      return createResultError(op, (stderr || stdout).trim() || `git exited ${exitCode}`, args.join(" "))
    return createResult(stdout)
  } catch (error) {
    return createResultError(op, migrationErrorMessage(error), args.join(" "))
  }
}

async function migrationGitStateRead(repository: string): PromiseResult<MigrationGitState> {
  const branchR = await migrationGitRun(repository, ["branch", "--show-current"])
  if (!branchR.success) return branchR
  const branch = branchR.data.trim()
  if (branch === "") return createResultError("migrationGitStateRead", "repository is in detached HEAD state")

  const revisionR = await migrationGitRun(repository, ["rev-parse", "--verify", "HEAD"])
  if (!revisionR.success) return revisionR
  const revision = revisionR.data.trim()
  if (revision === "") return createResultError("migrationGitStateRead", "repository has no HEAD revision")

  const statusR = await migrationGitRun(repository, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (!statusR.success) return statusR
  if (statusR.data.trim() !== "") return createResultError("migrationGitStateRead", "repository worktree is dirty")

  const remotesR = await migrationGitRun(repository, ["remote"])
  if (!remotesR.success) return remotesR
  const remotes = remotesR.data
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter((remote) => remote !== "")
    .sort()

  const configR = await migrationGitRun(repository, ["config", "--local", "--list"])
  if (!configR.success) return configR
  const configEntries = configR.data
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (entry.startsWith("remote.")) return true
      return entry.startsWith(`branch.${branch}.`)
    })
    .sort()

  const upstreamRemote = configEntries.find((entry) => entry.startsWith(`branch.${branch}.remote=`))
  const upstreamRef = configEntries.find((entry) => entry.startsWith(`branch.${branch}.merge=`))
  const upstream =
    upstreamRemote !== undefined && upstreamRef !== undefined
      ? {
          ref: upstreamRef.slice(`branch.${branch}.merge=`.length),
          remote: upstreamRemote.slice(`branch.${branch}.remote=`.length),
        }
      : null

  return createResult({ branch, configEntries, remotes, revision, upstream })
}

async function migrationRepositoryStateRead(repository: string): PromiseResult<MigrationRepositoryContext> {
  const rootR = await migrationGitRun(repository, ["rev-parse", "--show-toplevel"])
  if (!rootR.success) return rootR
  const root = rootR.data.trim()
  if (root !== repository)
    return createResultError("migrationRepositoryRead", "repository must be the Git worktree root")

  const stateR = await migrationGitStateRead(repository)
  if (!stateR.success) return stateR
  return createResult({ markerPath: join(repository, migrationMarkerPath), repository, state: stateR.data })
}

async function migrationRepositoryRead(path: string): PromiseResult<MigrationRepositoryContext> {
  let repository: string
  try {
    repository = await realpath(resolve(path))
  } catch (error) {
    return createResultError("migrationRepositoryRead", migrationErrorMessage(error), path)
  }

  const stateContextR = await migrationRepositoryStateRead(repository)
  if (!stateContextR.success) return stateContextR

  const markerPath = stateContextR.data.markerPath
  try {
    await lstat(markerPath)
    return createResultError(
      "migrationRepositoryRead",
      `${migrationMarkerPath} already exists; refusing a second migration`,
    )
  } catch (error) {
    if (!migrationMissing(error))
      return createResultError("migrationRepositoryRead", migrationErrorMessage(error), markerPath)
  }

  const migrationsDirectory = join(repository, "migrations")
  try {
    const stat = await lstat(migrationsDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return createResultError("migrationRepositoryRead", "migrations must be a real directory", "migrations")
    }
  } catch (error) {
    if (!migrationMissing(error))
      return createResultError("migrationRepositoryRead", migrationErrorMessage(error), "migrations")
  }

  return stateContextR
}

function migrationMarkerRead(input: unknown, path: string): Result<MigrationMarker> {
  const record = migrationRecordValue(input)
  if (record === null) return createResultError("migrationMarkerRead", "migration marker must be a JSON object", path)
  if (record.migration !== "legacy-v1" || record.schemaVersion !== 1) {
    return createResultError("migrationMarkerRead", "unsupported migration marker", path)
  }

  const stringValue = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === "string" ? value : undefined
  }
  const stringArrayValue = (key: string): string[] | undefined => {
    const value = record[key]
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined
    return value as string[]
  }
  const projectCount = record.projectCount
  const sourceUpstream = record.sourceUpstream
  const upstream =
    sourceUpstream === null
      ? null
      : migrationRecordValue(sourceUpstream) !== null &&
          typeof migrationRecordValue(sourceUpstream)?.ref === "string" &&
          typeof migrationRecordValue(sourceUpstream)?.remote === "string"
        ? {
            ref: migrationRecordValue(sourceUpstream)?.ref as string,
            remote: migrationRecordValue(sourceUpstream)?.remote as string,
          }
        : undefined
  const softwareOwner = record.softwareOwner
  const softwareProjects = record.softwareProjects
  if (
    typeof projectCount !== "number" ||
    !Number.isInteger(projectCount) ||
    projectCount < 0 ||
    stringArrayValue("projectPaths") === undefined ||
    stringValue("sourceBranch") === undefined ||
    stringArrayValue("sourceRemotes") === undefined ||
    stringValue("sourceRepository") === undefined ||
    stringValue("sourceRevision") === undefined ||
    upstream === undefined ||
    (softwareOwner !== null && typeof softwareOwner !== "string") ||
    stringArrayValue("softwareProjectFiles") === undefined ||
    (softwareProjects !== null && typeof softwareProjects !== "string")
  ) {
    return createResultError("migrationMarkerRead", "invalid migration marker", path)
  }

  return createResult({
    migration: "legacy-v1",
    projectCount,
    projectPaths: stringArrayValue("projectPaths")!,
    schemaVersion: 1,
    sourceBranch: stringValue("sourceBranch")!,
    sourceRemotes: stringArrayValue("sourceRemotes")!,
    sourceRepository: stringValue("sourceRepository")!,
    sourceRevision: stringValue("sourceRevision")!,
    sourceUpstream: upstream,
    softwareOwner: softwareOwner as string | null,
    softwareProjectFiles: stringArrayValue("softwareProjectFiles")!,
    softwareProjects: softwareProjects as string | null,
  })
}

async function migrationPathCanonical(path: string): PromiseResult<string> {
  const absolute = resolve(path)
  try {
    return createResult(await realpath(absolute))
  } catch (error) {
    if (!migrationMissing(error))
      return createResultError("migrationDestinationRead", migrationErrorMessage(error), path)
    try {
      return createResult(join(await realpath(dirname(absolute)), basename(absolute)))
    } catch (parentError) {
      return createResultError("migrationDestinationRead", migrationErrorMessage(parentError), dirname(absolute))
    }
  }
}

function migrationPathWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

async function migrationDestinationRead(
  source: MigrationRepositoryContext,
  path: string,
): PromiseResult<MigrationDestinationContext> {
  const destinationR = await migrationPathCanonical(path)
  if (!destinationR.success) return destinationR
  const destination = destinationR.data
  try {
    const requestedStat = await lstat(resolve(path))
    if (requestedStat.isSymbolicLink()) {
      if (destination === source.repository) {
        return createResultError("migrationDestinationRead", "source and destination repositories must be different")
      }
      return createResultError("migrationDestinationRead", "destination must not be a symbolic link", path)
    }
  } catch (error) {
    if (!migrationMissing(error))
      return createResultError("migrationDestinationRead", migrationErrorMessage(error), path)
  }
  if (destination === source.repository) {
    return createResultError("migrationDestinationRead", "source and destination repositories must be different")
  }
  if (migrationPathWithin(source.repository, destination)) {
    return createResultError("migrationDestinationRead", "destination must not be inside the source repository")
  }

  let destinationStat: Awaited<ReturnType<typeof lstat>>
  try {
    destinationStat = await lstat(destination)
  } catch (error) {
    if (migrationMissing(error)) return createResult({ repository: destination })
    return createResultError("migrationDestinationRead", migrationErrorMessage(error), destination)
  }
  if (destinationStat.isSymbolicLink()) {
    return createResultError("migrationDestinationRead", "destination must not be a symbolic link", destination)
  }
  if (!destinationStat.isDirectory()) {
    return createResultError("migrationDestinationRead", "destination is not a directory", destination)
  }

  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(destination, { withFileTypes: true })
  } catch (error) {
    return createResultError("migrationDestinationRead", migrationErrorMessage(error), destination)
  }
  if (entries.length === 0) return createResult({ repository: destination })

  const markerPath = join(destination, migrationMarkerPath)
  let markerInput: unknown
  try {
    const markerStat = await lstat(markerPath)
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
      return createResultError("migrationDestinationRead", "migration marker is not a regular file", markerPath)
    }
    markerInput = JSON.parse(await readFile(markerPath, "utf8"))
  } catch (error) {
    if (migrationMissing(error)) {
      return createResultError(
        "migrationDestinationRead",
        "refusing to replace a non-migration destination",
        destination,
      )
    }
    return createResultError("migrationDestinationRead", migrationErrorMessage(error), markerPath)
  }
  const markerR = migrationMarkerRead(markerInput, markerPath)
  if (!markerR.success) return markerR
  const stateR = await migrationRepositoryStateRead(destination)
  if (!stateR.success) return stateR
  return createResult({ marker: markerR.data, repository: destination, state: stateR.data.state })
}

function migrationYamlCommentStrip(line: string): string {
  let quote: "'" | '"' | undefined
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if ((character === "'" || character === '"') && (index === 0 || line[index - 1] !== "\\")) {
      if (quote === undefined) quote = character
      else if (quote === character) quote = undefined
      continue
    }
    if (character === "#" && quote === undefined && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index).trimEnd()
    }
  }
  return line.trimEnd()
}

function migrationYamlScalar(value: string): Result<unknown> {
  const text = value.trim()
  if (text === "") return createResult("")
  if (text === "null" || text === "~") return createResult(null)
  if (text === "true") return createResult(true)
  if (text === "false") return createResult(false)
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    const number = Number(text)
    if (Number.isFinite(number)) return createResult(number)
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, -1).trim()
    if (body === "") return createResult([])
    const values: unknown[] = []
    for (const item of body.split(",")) {
      const itemR = migrationYamlScalar(item)
      if (!itemR.success) return itemR
      values.push(itemR.data)
    }
    return createResult(values)
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return createResult(JSON.parse(text))
    } catch (error) {
      return createResultError("migrationYamlScalar", migrationErrorMessage(error))
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return createResult(text.slice(1, -1).replaceAll("''", "'"))
  return createResult(text)
}

function migrationYamlParse(text: string): Result<Record<string, unknown>> {
  const values: Record<string, unknown> = {}
  let servicesPending = false

  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = migrationYamlCommentStrip(rawLine)
    if (line.trim() === "") continue
    if (line.includes("\t"))
      return createResultError("migrationYamlParse", `tabs are unsupported on line ${lineIndex + 1}`)

    const indentation = line.length - line.trimStart().length
    const content = line.trim()
    if (indentation === 0) {
      servicesPending = false
      if (content === "---" || content === "...")
        return createResultError("migrationYamlParse", "document markers are unsupported")
      const separator = content.indexOf(":")
      if (separator < 1) return createResultError("migrationYamlParse", `invalid mapping on line ${lineIndex + 1}`)
      const key = content.slice(0, separator).trim()
      if (!/^[A-Za-z0-9_-]+$/.test(key)) return createResultError("migrationYamlParse", `invalid key ${key}`)
      if (Object.hasOwn(values, key)) return createResultError("migrationYamlParse", `duplicate key ${key}`)
      const rawValue = content.slice(separator + 1).trim()
      if (rawValue === "") {
        if (key !== "services") return createResultError("migrationYamlParse", `${key} must have a scalar value`)
        values[key] = []
        servicesPending = true
        continue
      }
      const valueR = migrationYamlScalar(rawValue)
      if (!valueR.success) return valueR
      values[key] = valueR.data
      continue
    }

    if (!servicesPending || !content.startsWith("-")) {
      return createResultError("migrationYamlParse", `unsupported nested YAML on line ${lineIndex + 1}`)
    }
    const itemR = migrationYamlScalar(content.slice(1).trim())
    if (!itemR.success) return itemR
    const services = values.services
    if (!Array.isArray(services)) return createResultError("migrationYamlParse", "services must be a list")
    services.push(itemR.data)
  }

  return createResult(values)
}

function migrationProjectValidate(input: unknown, path: string): Result<Project> {
  const parsed = a.safeParse(projectSchema, input)
  if (!parsed.success)
    return createResultError("migrationProjectValidate", `${path}: ${a.summarize(parsed.issues)}`, path)
  if (!migrationPathSegmentSafe(parsed.output.owner)) {
    return createResultError("migrationProjectValidate", `${path}: owner is not a safe path segment`, path)
  }
  if (parsed.output.caddy?.kind === "static" && parsed.output.caddy.path.trim() === "") {
    return createResultError("migrationProjectValidate", `${path}: static projects need a path`, path)
  }
  if (parsed.output.caddy !== undefined && parsed.output.caddy !== null) {
    const domains = parsed.output.caddy.domains.map(projectDomainNormalize)
    if (new Set(domains).size !== domains.length) {
      return createResultError("migrationProjectValidate", `${path}: project contains duplicate domains`, path)
    }
  }
  return createResult(parsed.output)
}

function migrationLegacyProjectConvert(
  input: unknown,
  owner: string,
  fileName: string,
): Result<{ project: Project; shared: boolean }> {
  const path = `projects/${owner}/${fileName}`
  const record = migrationRecordValue(input)
  if (record === null)
    return createResultError("migrationLegacyProjectConvert", `${path}: record must be an object`, path)

  for (const key of Object.keys(record)) {
    if (!caddyFields.has(key))
      return createResultError("migrationLegacyProjectConvert", `${path}: unsupported field ${key}`, path)
  }

  const name = record.name
  if (typeof name !== "string" || name !== basename(fileName, ".json")) {
    return createResultError("migrationLegacyProjectConvert", `${path}: name must match its filename`, path)
  }
  const user = record.user
  if (typeof user !== "string" || user !== owner) {
    return createResultError("migrationLegacyProjectConvert", `${path}: user must match its owner directory`, path)
  }
  if (record.template !== undefined && typeof record.template !== "boolean") {
    return createResultError("migrationLegacyProjectConvert", `${path}: template must be boolean`, path)
  }
  if (record.template === true) {
    return createResultError("migrationLegacyProjectConvert", `${path}: template records are unsupported`, path)
  }
  if (record.shared !== undefined && typeof record.shared !== "boolean") {
    return createResultError("migrationLegacyProjectConvert", `${path}: shared must be boolean`, path)
  }
  if (typeof record.port !== "number" || !Number.isInteger(record.port)) {
    return createResultError("migrationLegacyProjectConvert", `${path}: port must be an integer`, path)
  }
  if (!Array.isArray(record.domains)) {
    return createResultError("migrationLegacyProjectConvert", `${path}: domains must be an array`, path)
  }

  const domains: string[] = []
  for (const domain of record.domains) {
    if (typeof domain !== "string")
      return createResultError("migrationLegacyProjectConvert", `${path}: domain must be a string`, path)
    const normalized = projectDomainNormalize(domain)
    if (normalized === "")
      return createResultError("migrationLegacyProjectConvert", `${path}: domain cannot be empty`, path)
    domains.push(normalized)
  }

  const caddy: Record<string, unknown> = {
    access: record.access ?? "external",
    browse: record.browse ?? false,
    docs: record.docs ?? true,
    domains,
    disabled: record.disabled ?? false,
    headerUp: record.headerUp ?? {},
    kind: record.kind ?? "proxy",
    path: record.path ?? "",
    port: record.port,
  }
  for (const key of [
    "routed",
    "oidcPaths",
    "docsPath",
    "browseTemplate",
    "staticAllow",
    "denyDotfiles",
    "spa",
    "flushInterval",
  ]) {
    if (key in record) caddy[key] = record[key]
  }

  const projectR = migrationProjectValidate(
    {
      caddy,
      name,
      order: Number.MAX_SAFE_INTEGER,
      owner,
      schemaVersion: 1,
      services: [],
      type: "customer",
    },
    path,
  )
  if (!projectR.success) return projectR
  return createResult({ project: projectR.data, shared: record.shared === true })
}

async function migrationProjectFilesRead(
  repository: string,
): PromiseResult<{ records: MigrationProjectEntry[]; shared: string[] }> {
  const projectsDirectory = join(repository, "projects")
  let ownerEntries: import("node:fs").Dirent[]
  try {
    ownerEntries = await readdir(projectsDirectory, { withFileTypes: true })
  } catch (error) {
    return createResultError("migrationProjectFilesRead", migrationErrorMessage(error), "projects")
  }

  const records: MigrationProjectEntry[] = []
  const shared: string[] = []
  for (const ownerEntry of ownerEntries.sort((left, right) => migrationStringCompare(left.name, right.name))) {
    if (ownerEntry.isSymbolicLink()) {
      return createResultError(
        "migrationProjectFilesRead",
        `projects contains a non-directory owner: ${ownerEntry.name}`,
      )
    }
    if (!ownerEntry.isDirectory()) {
      if (!ownerEntry.name.endsWith(".json")) continue
      return createResultError(
        "migrationProjectFilesRead",
        `project JSON is not beneath an owner directory: ${ownerEntry.name}`,
      )
    }
    const ownerDirectory = join(projectsDirectory, ownerEntry.name)
    let projectEntries: import("node:fs").Dirent[]
    try {
      projectEntries = await readdir(ownerDirectory, { withFileTypes: true })
    } catch (error) {
      return createResultError("migrationProjectFilesRead", migrationErrorMessage(error), ownerEntry.name)
    }
    for (const projectEntry of projectEntries.sort((left, right) => migrationStringCompare(left.name, right.name))) {
      if (!projectEntry.name.endsWith(".json")) {
        if (projectEntry.isSymbolicLink()) {
          return createResultError(
            "migrationProjectFilesRead",
            `project file is not regular: ${ownerEntry.name}/${projectEntry.name}`,
          )
        }
        continue
      }
      if (projectEntry.isSymbolicLink() || !projectEntry.isFile()) {
        return createResultError(
          "migrationProjectFilesRead",
          `project file is not regular: ${ownerEntry.name}/${projectEntry.name}`,
        )
      }
      const relativePath = `projects/${ownerEntry.name}/${projectEntry.name}`
      const trackedR = await migrationGitRun(repository, ["ls-files", "--error-unmatch", "--", relativePath])
      if (!trackedR.success)
        return createResultError("migrationProjectFilesRead", `${relativePath}: project is not Git-tracked`)
      let input: unknown
      try {
        input = JSON.parse(await readFile(join(ownerDirectory, projectEntry.name), "utf8"))
      } catch (error) {
        return createResultError(
          "migrationProjectFilesRead",
          `${relativePath}: ${migrationErrorMessage(error)}`,
          relativePath,
        )
      }
      const convertedR = migrationLegacyProjectConvert(input, ownerEntry.name, projectEntry.name)
      if (!convertedR.success) return convertedR
      records.push({ path: relativePath, project: convertedR.data.project })
      if (convertedR.data.shared) shared.push(`${ownerEntry.name}/${basename(projectEntry.name, ".json")}`)
    }
  }

  return createResult({ records, shared })
}

async function migrationNameMappingRead(path: string | undefined): PromiseResult<Map<string, string>> {
  if (path === undefined) return createResult(new Map())
  let input: unknown
  try {
    input = JSON.parse(await readFile(resolve(path), "utf8"))
  } catch (error) {
    return createResultError("migrationNameMappingRead", migrationErrorMessage(error), path)
  }
  const record = migrationRecordValue(input)
  if (record === null) return createResultError("migrationNameMappingRead", "name mapping must be a JSON object", path)
  const mapping = new Map<string, string>()
  for (const [source, target] of Object.entries(record)) {
    if (typeof target !== "string" || !projectNamePattern.test(target)) {
      return createResultError(
        "migrationNameMappingRead",
        `${source}: mapping target is not a valid project name`,
        path,
      )
    }
    mapping.set(source, target)
  }
  return createResult(mapping)
}

function migrationSoftwareValue(record: Record<string, unknown>, key: string): string | undefined {
  return migrationText(record[key])
}

function migrationSoftwareOrder(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.MAX_SAFE_INTEGER
}

function migrationSoftwareType(value: unknown): "own" | "internal" | "customer" {
  const type = migrationText(value)?.toLowerCase()
  if (type === "own" || type === "internal" || type === "customer") return type
  return "customer"
}

function migrationSoftwareServices(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(value.map((item) => migrationText(item)).filter((item): item is string => item !== undefined)),
  ].filter((item) => serviceNamePattern.test(item))
}

function migrationSoftwareProjectConvert(
  input: unknown,
  fileName: string,
  owner: string,
  nameMapping: Map<string, string>,
): Result<MigrationSoftwareEntry> {
  const record = migrationRecordValue(input)
  if (record === null)
    return createResultError("migrationSoftwareProjectConvert", `${fileName}: record must be an object`)
  for (const key of Object.keys(record)) {
    if (!softwareFields.has(key))
      return createResultError("migrationSoftwareProjectConvert", `${fileName}: unsupported field ${key}`)
  }

  const sourceName = basename(fileName, extname(fileName))
  const name = nameMapping.get(sourceName) ?? sourceName
  if (!projectNamePattern.test(name)) {
    return createResultError(
      "migrationSoftwareProjectConvert",
      `${fileName}: invalid name; add --name-mapping`,
      fileName,
    )
  }
  const inputRecord: Record<string, unknown> = {
    caddy: null,
    name,
    order: migrationSoftwareOrder(record.order),
    owner,
    schemaVersion: 1,
    services: migrationSoftwareServices(record.services),
    type: migrationSoftwareType(record.type),
  }
  const fields: [string, string][] = [
    ["github", "github"],
    ["preview_url", "previewUrl"],
    ["preview_port", "previewPort"],
    ["production_url", "productionUrl"],
    ["production_assets_url", "productionAssetsUrl"],
  ]
  for (const [source, target] of fields) {
    const value = migrationSoftwareValue(record, source)
    if (value !== undefined) inputRecord[target] = value
  }

  const projectR = migrationProjectValidate(inputRecord, `software/${fileName}`)
  if (!projectR.success) return projectR
  return createResult({ file: fileName, project: projectR.data })
}

async function migrationSoftwareFilesRead(
  path: string,
  owner: string,
  nameMapping: Map<string, string>,
): PromiseResult<{ entries: MigrationSoftwareEntry[]; directory: string }> {
  let directory: string
  try {
    directory = await realpath(resolve(path))
  } catch (error) {
    return createResultError("migrationSoftwareFilesRead", migrationErrorMessage(error), path)
  }
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(directory)
  } catch (error) {
    return createResultError("migrationSoftwareFilesRead", migrationErrorMessage(error), path)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    return createResultError("migrationSoftwareFilesRead", "software path must be a real directory")

  let files: import("node:fs").Dirent[]
  try {
    files = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    return createResultError("migrationSoftwareFilesRead", migrationErrorMessage(error), path)
  }

  const entries: MigrationSoftwareEntry[] = []
  const names = new Set<string>()
  for (const file of files
    .filter((entry) => entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
    .sort((left, right) => migrationStringCompare(left.name, right.name))) {
    if (file.isSymbolicLink() || !file.isFile())
      return createResultError("migrationSoftwareFilesRead", `${file.name}: not a regular file`)
    const sourceName = basename(file.name, extname(file.name))
    const targetName = nameMapping.get(sourceName) ?? sourceName
    if (names.has(targetName))
      return createResultError("migrationSoftwareFilesRead", `duplicate software name: ${targetName}`)
    names.add(targetName)
    let input: string
    try {
      input = await readFile(join(directory, file.name), "utf8")
    } catch (error) {
      return createResultError("migrationSoftwareFilesRead", `${file.name}: ${migrationErrorMessage(error)}`, file.name)
    }
    const parsedR = migrationYamlParse(input)
    if (!parsedR.success)
      return createResultError("migrationSoftwareFilesRead", `${file.name}: ${parsedR.errorMessage}`, file.name)
    const convertedR = migrationSoftwareProjectConvert(parsedR.data, file.name, owner, nameMapping)
    if (!convertedR.success) return convertedR
    entries.push(convertedR.data)
  }

  return createResult({ directory, entries })
}

function migrationProjectMerge(project: Project, software: Project, path: string): Result<Project> {
  const input: Record<string, unknown> = {
    ...project,
    github: software.github,
    order: software.order,
    previewPort: software.previewPort,
    previewUrl: software.previewUrl,
    productionAssetsUrl: software.productionAssetsUrl,
    productionUrl: software.productionUrl,
    services: software.services,
    type: software.type,
  }
  for (const key of ["github", "previewPort", "previewUrl", "productionAssetsUrl", "productionUrl"]) {
    if (input[key] === undefined) delete input[key]
  }
  return migrationProjectValidate(input, path)
}

function migrationPlanCollisions(records: MigrationProjectEntry[]): Result<void> {
  const keys = new Set<string>()
  for (const record of records) {
    const key = migrationProjectKey(record.project.owner, record.project.name)
    if (keys.has(key)) return createResultError("migrationPlanCollisions", `duplicate project: ${key}`)
    keys.add(key)
  }
  const collisionR = projectCollisions(records.map((record) => record.project))
  if (!collisionR.success) return createResultError("migrationPlanCollisions", collisionR.errorMessage)
  return createResult(undefined)
}

async function migrationPlanBuild(
  context: MigrationRepositoryContext,
  options: MigrationOptions,
): PromiseResult<MigrationPlan> {
  const caddyR = await migrationProjectFilesRead(context.repository)
  if (!caddyR.success) return caddyR
  const mappingR = await migrationNameMappingRead(options.nameMappingPath)
  if (!mappingR.success) return mappingR

  let softwareEntries: MigrationSoftwareEntry[] = []
  let softwareDirectory: string | null = null
  if (options.softwareProjectsPath !== undefined) {
    if (options.softwareOwner === undefined || options.softwareOwner.trim() === "") {
      return createResultError("migrationPlanBuild", "--software-owner is required with --software-projects")
    }
    const softwareR = await migrationSoftwareFilesRead(
      options.softwareProjectsPath,
      options.softwareOwner.trim(),
      mappingR.data,
    )
    if (!softwareR.success) return softwareR
    softwareEntries = softwareR.data.entries
    softwareDirectory = softwareR.data.directory
  }

  const recordsByKey = new Map<string, MigrationProjectEntry>()
  for (const record of caddyR.data.records)
    recordsByKey.set(migrationProjectKey(record.project.owner, record.project.name), record)
  const sharedConversions = [...caddyR.data.shared].sort()
  for (const software of softwareEntries) {
    const key = migrationProjectKey(software.project.owner, software.project.name)
    const existing = recordsByKey.get(key)
    if (existing === undefined) {
      const path = `projects/${software.project.owner}/${software.project.name}.json`
      const projectR = migrationProjectValidate(software.project, path)
      if (!projectR.success) return projectR
      recordsByKey.set(key, { path, project: projectR.data })
      continue
    }
    const projectR = migrationProjectMerge(existing.project, software.project, existing.path)
    if (!projectR.success) return projectR
    recordsByKey.set(key, { path: existing.path, project: projectR.data })
  }

  const records = [...recordsByKey.values()].sort((left, right) => migrationStringCompare(left.path, right.path))
  const collisionsR = migrationPlanCollisions(records)
  if (!collisionsR.success) return collisionsR

  const marker: MigrationMarker = {
    migration: "legacy-v1",
    projectCount: records.length,
    projectPaths: records.map((record) => record.path),
    schemaVersion: 1,
    sourceBranch: context.state.branch,
    sourceRemotes: context.state.remotes,
    sourceRepository: context.repository,
    sourceRevision: context.state.revision,
    sourceUpstream: context.state.upstream,
    softwareOwner: options.softwareOwner?.trim() ?? null,
    softwareProjectFiles: softwareEntries.map((entry) => entry.file).sort(),
    softwareProjects: softwareDirectory,
  }
  return createResult({ marker, records, sharedConversions })
}

async function migrationGitClone(source: string, destination: string, branch: string): PromiseResult<void> {
  try {
    const process = Bun.spawn(
      ["git", "clone", "--no-hardlinks", "--dissociate", "--branch", branch, source, destination],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (exitCode !== 0) {
      return createResultError(
        "migrationGitClone",
        (stderr || stdout).trim() || `git clone exited ${exitCode}`,
        destination,
      )
    }
    return createResult(undefined)
  } catch (error) {
    return createResultError("migrationGitClone", migrationErrorMessage(error), destination)
  }
}

function migrationRegexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function migrationDestinationConfigPreserve(
  destination: string,
  sourceState: MigrationGitState,
): PromiseResult<void> {
  const remoteKeysR = await migrationGitRun(destination, ["config", "--local", "--get-regexp", "^remote\\."])
  if (remoteKeysR.success) {
    const remoteKeys = new Set(
      remoteKeysR.data
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/, 1)[0])
        .filter((key): key is string => key !== undefined && key !== ""),
    )
    for (const key of remoteKeys) {
      const unsetR = await migrationGitRun(destination, ["config", "--local", "--unset-all", key])
      if (!unsetR.success) return unsetR
    }
  } else if (!remoteKeysR.errorMessage.endsWith("git exited 1")) {
    return remoteKeysR
  }

  const branchPattern = `^branch\\.${migrationRegexEscape(sourceState.branch)}\\.`
  const branchKeysR = await migrationGitRun(destination, ["config", "--local", "--get-regexp", branchPattern])
  if (branchKeysR.success) {
    for (const key of branchKeysR.data
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 1)[0])
      .filter((key): key is string => key !== undefined && key !== "")) {
      const unsetR = await migrationGitRun(destination, ["config", "--local", "--unset-all", key])
      if (!unsetR.success) return unsetR
    }
  } else if (!branchKeysR.errorMessage.endsWith("git exited 1")) {
    return branchKeysR
  }

  for (const entry of sourceState.configEntries) {
    const separator = entry.indexOf("=")
    if (separator < 1)
      return createResultError("migrationDestinationConfigPreserve", `invalid Git config entry: ${entry}`)
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    const addR = await migrationGitRun(destination, ["config", "--local", "--add", key, value])
    if (!addR.success) return addR
  }
  return createResult(undefined)
}

function migrationGitStateEqual(left: MigrationGitState, right: MigrationGitState): boolean {
  return (
    left.branch === right.branch &&
    left.revision === right.revision &&
    JSON.stringify(left.configEntries) === JSON.stringify(right.configEntries) &&
    JSON.stringify(left.remotes) === JSON.stringify(right.remotes) &&
    JSON.stringify(left.upstream) === JSON.stringify(right.upstream)
  )
}

async function migrationDestinationClone(
  source: MigrationRepositoryContext,
  destination: string,
): PromiseResult<MigrationRepositoryContext> {
  const cloneR = await migrationGitClone(source.repository, destination, source.state.branch)
  if (!cloneR.success) return cloneR
  const configR = await migrationDestinationConfigPreserve(destination, source.state)
  if (!configR.success) return configR
  const stateR = await migrationRepositoryStateRead(destination)
  if (!stateR.success) return stateR
  if (!migrationGitStateEqual(source.state, stateR.data.state)) {
    return createResultError(
      "migrationDestinationClone",
      "clone did not preserve Git branch, history, remote, or upstream state",
    )
  }
  return stateR
}

function migrationMarkerEqual(left: MigrationMarker, right: MigrationMarker): boolean {
  return (
    left.migration === right.migration &&
    left.projectCount === right.projectCount &&
    JSON.stringify(left.projectPaths) === JSON.stringify(right.projectPaths) &&
    left.schemaVersion === right.schemaVersion &&
    left.sourceBranch === right.sourceBranch &&
    JSON.stringify(left.sourceRemotes) === JSON.stringify(right.sourceRemotes) &&
    left.sourceRepository === right.sourceRepository &&
    left.sourceRevision === right.sourceRevision &&
    JSON.stringify(left.sourceUpstream) === JSON.stringify(right.sourceUpstream) &&
    left.softwareOwner === right.softwareOwner &&
    JSON.stringify(left.softwareProjectFiles) === JSON.stringify(right.softwareProjectFiles) &&
    left.softwareProjects === right.softwareProjects
  )
}

async function migrationDestinationExistingValidate(
  context: MigrationDestinationContext,
  source: MigrationRepositoryContext,
  plan: MigrationPlan,
): PromiseResult<MigrationCompleted> {
  if (context.marker === undefined || context.state === undefined) {
    return createResultError("migrationDestinationExistingValidate", "destination is not a completed migration")
  }
  if (!migrationMarkerEqual(context.marker, plan.marker)) {
    return createResultError(
      "migrationDestinationExistingValidate",
      "destination migration does not match the source; refusing to replace it",
    )
  }
  if (
    context.state.branch !== source.state.branch ||
    JSON.stringify(context.state.configEntries) !== JSON.stringify(source.state.configEntries) ||
    JSON.stringify(context.state.remotes) !== JSON.stringify(source.state.remotes) ||
    JSON.stringify(context.state.upstream) !== JSON.stringify(source.state.upstream)
  ) {
    return createResultError(
      "migrationDestinationExistingValidate",
      "destination Git remote or branch configuration changed",
    )
  }

  const parentR = await migrationGitRun(context.repository, ["rev-parse", "HEAD^"])
  if (!parentR.success || parentR.data.trim() !== source.state.revision) {
    return createResultError(
      "migrationDestinationExistingValidate",
      "destination migration does not preserve source history",
    )
  }
  const subjectR = await migrationGitRun(context.repository, ["show", "-s", "--format=%s", "HEAD"])
  if (!subjectR.success) return subjectR
  if (subjectR.data.trim() !== "project-registry migrate legacy-v1") {
    return createResultError("migrationDestinationExistingValidate", "destination HEAD is not the migration commit")
  }
  const trackedR = await migrationGitRun(context.repository, ["ls-files", "--error-unmatch", "--", migrationMarkerPath])
  if (!trackedR.success)
    return createResultError("migrationDestinationExistingValidate", "migration marker is not Git-tracked")

  for (const record of plan.records) {
    let content: string
    try {
      content = await readFile(join(context.repository, record.path), "utf8")
    } catch (error) {
      return createResultError("migrationDestinationExistingValidate", migrationErrorMessage(error), record.path)
    }
    if (content !== `${JSON.stringify(record.project, null, 2)}\n`) {
      return createResultError(
        "migrationDestinationExistingValidate",
        "destination project conversion differs from the migration plan",
        record.path,
      )
    }
  }
  return createResult({ commit: context.state.revision })
}

async function migrationDirectoryEnsure(path: string): PromiseResult<void> {
  try {
    await mkdir(path, { recursive: true })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return createResultError("migrationDirectoryEnsure", "path is not a real directory", path)
    return createResult(undefined)
  } catch (error) {
    return createResultError("migrationDirectoryEnsure", migrationErrorMessage(error), path)
  }
}

async function migrationFileWrite(path: string, content: string): PromiseResult<void> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    fileHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    )
    await fileHandle.writeFile(content, "utf8")
    return createResult(undefined)
  } catch (error) {
    return createResultError("migrationFileWrite", migrationErrorMessage(error), path)
  } finally {
    await fileHandle?.close()
  }
}

async function migrationApply(
  context: MigrationRepositoryContext,
  plan: MigrationPlan,
): PromiseResult<MigrationCompleted> {
  const stateR = await migrationGitStateRead(context.repository)
  if (!stateR.success) return stateR
  if (stateR.data.revision !== context.state.revision) {
    return createResultError("migrationApply", "repository changed after planning; run the dry-run again")
  }

  for (const record of plan.records) {
    const directoryR = await migrationDirectoryEnsure(dirname(join(context.repository, record.path)))
    if (!directoryR.success) return directoryR
    const writeR = await migrationFileWrite(
      join(context.repository, record.path),
      `${JSON.stringify(record.project, null, 2)}\n`,
    )
    if (!writeR.success) return writeR
  }
  const markerDirectoryR = await migrationDirectoryEnsure(join(context.repository, "migrations"))
  if (!markerDirectoryR.success) return markerDirectoryR
  const markerR = await migrationFileWrite(
    join(context.repository, migrationMarkerPath),
    `${JSON.stringify(plan.marker, null, 2)}\n`,
  )
  if (!markerR.success) return markerR

  const paths = [...plan.records.map((record) => record.path), migrationMarkerPath]
  const addR = await migrationGitRun(context.repository, ["add", "--", ...paths])
  if (!addR.success) return addR
  const commitR = await migrationGitRun(
    context.repository,
    ["commit", "-m", "project-registry migrate legacy-v1"],
    true,
  )
  if (!commitR.success) return commitR
  const revisionR = await migrationGitRun(context.repository, ["rev-parse", "--verify", "HEAD"])
  if (!revisionR.success) return revisionR
  const revision = revisionR.data.trim()
  const authorR = await migrationGitRun(context.repository, ["show", "-s", "--format=%an <%ae>", "HEAD"])
  if (!authorR.success) return authorR
  if (authorR.data.trim() !== "project-registry <project-registry@localhost>") {
    return createResultError("migrationApply", "migration commit has the wrong Git identity")
  }
  const parentR = await migrationGitRun(context.repository, ["rev-parse", "HEAD^"])
  if (context.state.revision !== "" && (!parentR.success || parentR.data.trim() !== context.state.revision)) {
    return createResultError("migrationApply", "migration commit did not preserve the source history")
  }
  const branchR = await migrationGitRun(context.repository, ["branch", "--show-current"])
  if (!branchR.success) return branchR
  if (branchR.data.trim() !== context.state.branch)
    return createResultError("migrationApply", "migration changed the source branch")
  const configR = await migrationGitRun(context.repository, ["config", "--local", "--list"])
  if (!configR.success) return configR
  const configEntries = configR.data
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (entry.startsWith("remote.")) return true
      return entry.startsWith(`branch.${context.state.branch}.`)
    })
    .sort()
  if (JSON.stringify(configEntries) !== JSON.stringify(context.state.configEntries)) {
    return createResultError("migrationApply", "migration changed Git remote or branch configuration")
  }
  const statusR = await migrationGitRun(context.repository, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (!statusR.success) return statusR
  if (statusR.data.trim() !== "") return createResultError("migrationApply", "migration commit left the worktree dirty")
  return createResult({ commit: revision })
}

function migrationReportValue(
  plan: MigrationPlan,
  mode: "apply" | "dry-run",
  completed: MigrationCompleted | undefined,
  destinationRepository: string | null,
): MigrationReport {
  return {
    ...(completed === undefined ? {} : { completed }),
    destinationRepository,
    marker: plan.marker,
    mode,
    records: plan.records,
    sharedConversions: plan.sharedConversions,
  }
}

function migrationUsage(): string {
  return `Usage:
  bun run ops/migration/legacy-migrate.ts --repository SOURCE [--destination-repository DESTINATION] [options]

Options:
  --dry-run                 Preview only (the default)
  --apply                   Clone SOURCE and write records, marker, and one Git commit in DESTINATION
  --repository PATH         Existing legacy Git worktree (read-only)
  --destination-repository PATH
                            Separate migrated Git worktree; required with --apply
  --software-projects PATH  Read legacy Software YAML records from PATH
  --software-owner OWNER    Owner for Software records (required with --software-projects)
  --name-mapping PATH       JSON object mapping invalid YAML filename stems to valid names
  --json                    Emit the plan/report as JSON
  --help                    Show this help

SOURCE must be the existing Git worktree containing projects/<owner>/*.json. DESTINATION
is never replaced unless it is an already completed matching migration. Cloning uses copied
objects with no hardlinks or alternates; SOURCE is never written.`
}

function migrationReportWrite(report: MigrationReport, options: MigrationOptions): void {
  if (options.json) {
    console.log(JSON.stringify({ ...report, repository: resolve(options.repository) }, null, 2))
    return
  }
  console.log(`${report.mode}: ${report.records.length} project records from ${resolve(options.repository)}`)
  if (report.destinationRepository !== null) console.log(`destination: ${report.destinationRepository}`)
  console.log(`source: ${report.marker.sourceBranch} @ ${report.marker.sourceRevision}`)
  for (const record of report.records) console.log(`${record.path}: ${JSON.stringify(record.project)}`)
  if (report.sharedConversions.length > 0) {
    console.log(`shared records converted to private ownership: ${report.sharedConversions.join(", ")}`)
  }
  console.log(`${report.completed === undefined ? "would write" : "wrote"} ${migrationMarkerPath}`)
  if (report.completed === undefined) console.log("would commit project-registry migrate legacy-v1")
  else console.log(`committed ${report.completed.commit}: project-registry migrate legacy-v1`)
}

async function migrationRun(options: MigrationOptions): PromiseResult<MigrationReport> {
  const contextR = await migrationRepositoryRead(options.repository)
  if (!contextR.success) return contextR
  const planR = await migrationPlanBuild(contextR.data, options)
  if (!planR.success) return planR
  if (options.destinationRepository === undefined) {
    if (options.apply) return createResultError("migrationRun", "--destination-repository is required with --apply")
    return createResult(migrationReportValue(planR.data, "dry-run", undefined, null))
  }

  const destinationR = await migrationDestinationRead(contextR.data, options.destinationRepository)
  if (!destinationR.success) return destinationR
  if (!options.apply)
    return createResult(migrationReportValue(planR.data, "dry-run", undefined, destinationR.data.repository))

  if (destinationR.data.marker !== undefined) {
    const completedR = await migrationDestinationExistingValidate(destinationR.data, contextR.data, planR.data)
    if (!completedR.success) return completedR
    return createResult(migrationReportValue(planR.data, "apply", completedR.data, destinationR.data.repository))
  }

  const destinationContextR = await migrationDestinationClone(contextR.data, destinationR.data.repository)
  if (!destinationContextR.success) return destinationContextR
  const completedR = await migrationApply(destinationContextR.data, planR.data)
  if (!completedR.success) return completedR
  return createResult(migrationReportValue(planR.data, "apply", completedR.data, destinationR.data.repository))
}

const argumentsR = migrationArgumentsParse(process.argv.slice(2))
if (!argumentsR.success) {
  console.error(`migration failed: ${argumentsR.errorMessage}`)
  process.exitCode = 1
} else if (argumentsR.data.help) {
  console.log(migrationUsage())
} else {
  const reportR = await migrationRun(argumentsR.data.options)
  if (!reportR.success) {
    console.error(`migration failed: ${reportR.errorMessage}`)
    process.exitCode = 1
  } else {
    migrationReportWrite(reportR.data, argumentsR.data.options)
  }
}
