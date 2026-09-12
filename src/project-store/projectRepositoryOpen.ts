import { constants, type Dirent } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import * as a from "valibot"
import {
  type GitStore,
  type GitStoreCommitInfo,
  gitStoreHistory,
  gitStoreList,
  gitStoreOpen,
  gitStoreRead,
  gitStoreRun,
} from "#git-store"
import { createResult, createResultError, createResultErrorCode, type PromiseResult, type Result } from "#result"
import { caddyConfigGenerate } from "../caddy/caddyConfigGenerate.js"
import { caddyConfigSerialize } from "../caddy/caddyConfigSerialize.js"
import type { Project } from "../project/Project.js"
import type { ProjectCanonical } from "../project/projectCanonicalSchema.js"
import { projectCollisions } from "../project/projectCollisions.js"
import type { ProjectKey } from "../project/projectKey.js"
import { projectKeyEqual } from "../project/projectKeyEqual.js"
import { projectMigrate } from "../project/projectMigrate.js"
import { projectMutationExpectedRevision } from "../project/projectMutationExpectedRevision.js"
import { projectRevisionValidate } from "../project/projectRevisionValidate.js"
import type { ProjectService } from "../project/projectServiceSchema.js"
import type { UserDefaultDomain } from "../user-default-domain/UserDefaultDomain.js"
import type { UserDefaultDomainEntry } from "../user-default-domain/UserDefaultDomainEntry.js"
import type { UserDefaultDomainMutation } from "../user-default-domain/UserDefaultDomainMutation.js"
import { userDefaultDomainPath } from "../user-default-domain/userDefaultDomainPath.js"
import { userDefaultDomainSchema } from "../user-default-domain/userDefaultDomainSchema.js"
import { userDefaultDomainValidate } from "../user-default-domain/userDefaultDomainValidate.js"
import type { ProjectRepository } from "./ProjectRepository.js"
import type { ProjectRepositoryEntry } from "./ProjectRepositoryEntry.js"
import type { ProjectRepositoryMigration } from "./ProjectRepositoryMigration.js"
import type { ProjectRepositoryMigrationOptions } from "./ProjectRepositoryMigrationOptions.js"
import type { ProjectRepositoryMutation } from "./ProjectRepositoryMutation.js"
import type { ProjectRepositoryMutationOptions } from "./ProjectRepositoryMutationOptions.js"
import { projectRepositoryOptionsSchema } from "./ProjectRepositoryOptions.js"
import type { ProjectRepositoryReadiness } from "./ProjectRepositoryReadiness.js"
import type { ProjectRepositoryServiceGrouping } from "./ProjectRepositoryServiceGrouping.js"
import type { ProjectRepositorySnapshot } from "./ProjectRepositorySnapshot.js"
import { projectRepositoryOwnerPath } from "./projectRepositoryOwnerPath.js"
import { projectRepositoryPath } from "./projectRepositoryPath.js"

const daemonAuthorName = "project-registry"
const daemonAuthorEmail = "project-registry@localhost"

type GitProjectRepository = {
  git: GitStore
  autoPush: boolean
  queueKey: string
}

type WorktreeStatus = {
  clean: boolean
}

type GitTreeEntry = {
  object: string
  path: string
  stage: string
}

type ProjectRepositoryUpstream = {
  remote: string
  ref: string
}

const mutationQueues = new Map<string, Promise<void>>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function projectRepositoryNoHead(error: string): boolean {
  const message = error.toLowerCase()
  return (
    message.includes("does not have any commits") ||
    message.includes("bad revision") ||
    message.includes("unknown revision") ||
    message.includes("ambiguous argument 'head'") ||
    message.includes("needed a single revision")
  )
}

async function projectRepositoryRevision(store: GitProjectRepository): PromiseResult<string> {
  const revisionR = await gitStoreRun(store.git, ["rev-parse", "--verify", "HEAD"])
  if (!revisionR.success) {
    if (projectRepositoryNoHead(revisionR.errorMessage)) return createResult("")
    return revisionR
  }
  return projectRevisionValidate(revisionR.data.trim(), "projectRepositoryRevision")
}

async function projectRepositoryWorktreeStatus(store: GitProjectRepository): PromiseResult<WorktreeStatus> {
  const statusR = await gitStoreRun(store.git, ["status", "--porcelain", "--untracked-files=all"])
  if (!statusR.success) return statusR
  return createResult({ clean: statusR.data.trim() === "" })
}

function projectRepositoryParseTreeEntries(data: string, index: boolean): Result<Map<string, GitTreeEntry[]>> {
  const entries = new Map<string, GitTreeEntry[]>()
  for (const record of data.split("\0")) {
    if (record === "") continue
    const separator = record.indexOf("\t")
    if (separator < 0) return createResultError("projectRepositoryRead", "invalid Git tree entry")

    const metadata = record.slice(0, separator).split(" ")
    const path = record.slice(separator + 1)
    const object = index ? metadata[1] : metadata[2]
    const stage = index ? metadata[2] : "0"
    if (!object || !stage || path === "") return createResultError("projectRepositoryRead", "invalid Git tree entry")

    const pathEntries = entries.get(path) ?? []
    pathEntries.push({ object, path, stage })
    entries.set(path, pathEntries)
  }
  return createResult(entries)
}

function projectRepositoryTreeEntriesEqual(left: GitTreeEntry[], right: GitTreeEntry[]): boolean {
  const normalize = (entries: GitTreeEntry[]) =>
    entries
      .map((entry) => `${entry.stage}:${entry.object}`)
      .sort()
      .join(",")
  return normalize(left) === normalize(right)
}

async function projectRepositoryTrackedDivergence(store: GitProjectRepository, op: string): PromiseResult<void> {
  const revisionR = await projectRepositoryRevision(store)
  if (!revisionR.success) return revisionR
  if (revisionR.data === "") return createResult(undefined)

  const headR = await gitStoreRun(store.git, ["ls-tree", "-r", "-z", "HEAD"])
  if (!headR.success) return headR
  const indexR = await gitStoreRun(store.git, ["ls-files", "--cached", "--stage", "-z"])
  if (!indexR.success) return indexR

  const headEntriesR = projectRepositoryParseTreeEntries(headR.data, false)
  if (!headEntriesR.success) return headEntriesR
  const indexEntriesR = projectRepositoryParseTreeEntries(indexR.data, true)
  if (!indexEntriesR.success) return indexEntriesR

  const headEntries = headEntriesR.data
  const indexEntries = indexEntriesR.data
  const paths = new Set([...headEntries.keys(), ...indexEntries.keys()])
  for (const path of paths) {
    const headPathEntries = headEntries.get(path) ?? []
    const indexPathEntries = indexEntries.get(path) ?? []
    if (!projectRepositoryTreeEntriesEqual(headPathEntries, indexPathEntries)) {
      const subject = path.startsWith("projects/") ? "tracked project index" : "tracked index"
      return createResultError(op, `${path}: ${subject} diverges from HEAD`, path)
    }
  }

  for (const path of headEntries.keys()) {
    const hashR = await gitStoreRun(store.git, ["hash-object", `--path=${path}`, "--", path])
    if (!hashR.success) {
      const subject = path.startsWith("projects/") ? "tracked project file" : "tracked file"
      return createResultError(op, `${path}: ${subject} diverges from HEAD`, path)
    }

    const headObject = headEntries.get(path)?.[0]?.object
    if (!headObject || hashR.data.trim() !== headObject) {
      const subject = path.startsWith("projects/") ? "tracked project file" : "tracked file"
      return createResultError(op, `${path}: ${subject} diverges from HEAD`, path)
    }
  }

  return createResult(undefined)
}

async function projectRepositoryCurrentBranch(git: GitStore): PromiseResult<string> {
  const branchR = await gitStoreRun(git, ["branch", "--show-current"])
  if (!branchR.success) return branchR
  return createResult(branchR.data.trim())
}

async function projectRepositoryRequireConfiguredBranch(git: GitStore, op: string): PromiseResult<void> {
  const branchR = await projectRepositoryCurrentBranch(git)
  if (!branchR.success) return branchR
  if (branchR.data === git.branch) return createResult(undefined)

  const currentBranch = branchR.data === "" ? "(detached HEAD)" : branchR.data
  return createResultError(
    op,
    `current branch ${currentBranch} does not match configured branch ${git.branch}; refusing to open repository`,
    git.dir,
  )
}

async function projectRepositoryReadiness(store: GitProjectRepository): PromiseResult<ProjectRepositoryReadiness> {
  const branchR = await projectRepositoryRequireConfiguredBranch(store.git, "projectRepositoryReadiness")
  if (!branchR.success) return branchR

  const statusR = await projectRepositoryWorktreeStatus(store)
  if (!statusR.success) return statusR

  const revisionR = await projectRepositoryRevision(store)
  if (!revisionR.success) return revisionR

  if (statusR.data.clean) {
    const snapshotR = await projectRepositoryReadSnapshot(store)
    if (!snapshotR.success) {
      return createResult({ ready: false, clean: true, revision: revisionR.data, reason: snapshotR.errorMessage })
    }
    return createResult({ ready: true, clean: true, revision: snapshotR.data.revision })
  }

  return createResult({
    ready: false,
    clean: false,
    revision: revisionR.data,
    reason: "worktree is dirty; recover from HEAD before reading or mutating projects",
  })
}

async function projectRepositoryRequireClean(store: GitProjectRepository, op: string): PromiseResult<void> {
  const statusR = await projectRepositoryWorktreeStatus(store)
  if (!statusR.success) return statusR
  if (!statusR.data.clean) {
    return createResultErrorCode(
      op,
      "worktree is dirty; recover from HEAD before reading or mutating projects",
      "projects.conflict",
    )
  }
  const divergenceR = await projectRepositoryTrackedDivergence(store, op)
  if (!divergenceR.success) return divergenceR
  return createResult(undefined)
}

function projectRepositoryMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function projectRepositoryDirectorySafe(
  directory: string,
  relativeDirectory: string,
  rootName: string,
  op: string,
): PromiseResult<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    return createResultError(op, errorMessage(error), relativeDirectory)
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relativePath = `${relativeDirectory}/${entry.name}`
    let pathStat: Awaited<ReturnType<typeof lstat>>
    try {
      pathStat = await lstat(path)
    } catch (error) {
      return createResultError(op, errorMessage(error), relativePath)
    }

    if (entry.name === ".git" || pathStat.isSymbolicLink()) {
      return createResultError(
        op,
        `symbolic links and reserved .git paths are not allowed beneath ${rootName}`,
        relativePath,
      )
    }

    if (pathStat.isDirectory()) {
      const safeR = await projectRepositoryDirectorySafe(path, relativePath, rootName, op)
      if (!safeR.success) return safeR
    }
  }

  return createResult(undefined)
}

async function projectRepositoryRootSafe(
  store: GitProjectRepository,
  rootName: string,
  op: string,
): PromiseResult<void> {
  let currentDir: string
  try {
    currentDir = await realpath(store.git.dir)
  } catch (error) {
    return createResultError(op, errorMessage(error), store.git.dir)
  }
  if (currentDir !== store.queueKey) {
    return createResultError(op, "worktree path is not the canonical real worktree")
  }

  const root = join(store.git.dir, rootName)
  let rootStat: Awaited<ReturnType<typeof lstat>>
  try {
    rootStat = await lstat(root)
  } catch (error) {
    if (projectRepositoryMissing(error)) return createResult(undefined)
    return createResultError(op, errorMessage(error), rootName)
  }

  if (rootStat.isSymbolicLink()) {
    return createResultError(op, `symbolic links and reserved .git paths are not allowed beneath ${rootName}`, rootName)
  }
  if (!rootStat.isDirectory()) return createResultError(op, `${rootName} is not a directory`)
  return projectRepositoryDirectorySafe(root, rootName, rootName, op)
}

async function projectRepositoryProjectsSafe(store: GitProjectRepository): PromiseResult<void> {
  return projectRepositoryRootSafe(store, "projects", "projectRepositoryProjectsSafe")
}

async function projectRepositoryUsersSafe(store: GitProjectRepository): PromiseResult<void> {
  return projectRepositoryRootSafe(store, "users", "projectRepositoryUserDefaultDomainSafe")
}

async function projectRepositoryTrackedPaths(store: GitProjectRepository): PromiseResult<Set<string>> {
  const trackedR = await gitStoreRun(store.git, ["ls-files", "--cached", "--full-name", "-z"])
  if (!trackedR.success) return trackedR

  const tracked = new Set<string>()
  for (const path of trackedR.data.split("\0")) {
    if (path !== "") tracked.add(path)
  }
  return createResult(tracked)
}

async function projectRepositoryParentDirectory(
  store: GitProjectRepository,
  relativeDirectory: string,
): PromiseResult<string> {
  const segments = relativeDirectory.split("/")
  let directory = store.git.dir

  for (const segment of segments) {
    directory = join(directory, segment)
    let directoryStat: Awaited<ReturnType<typeof lstat>>
    try {
      directoryStat = await lstat(directory)
    } catch (error) {
      if (!projectRepositoryMissing(error)) {
        return createResultError("projectRepositoryWrite", errorMessage(error), relativeDirectory)
      }
      try {
        await mkdir(directory)
        directoryStat = await lstat(directory)
      } catch (mkdirError) {
        return createResultError("projectRepositoryWrite", errorMessage(mkdirError), relativeDirectory)
      }
    }

    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return createResultError(
        "projectRepositoryWrite",
        "project path contains a non-directory component",
        relativeDirectory,
      )
    }
  }

  return createResult(directory)
}

async function projectRepositoryGitRunWithDaemonIdentity(
  store: GitProjectRepository,
  args: string[],
): PromiseResult<string> {
  const op = "projectRepositoryGitRunWithDaemonIdentity"
  try {
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(Bun.env)) {
      if (value !== undefined) environment[key] = value
    }
    environment.GIT_AUTHOR_NAME = daemonAuthorName
    environment.GIT_AUTHOR_EMAIL = daemonAuthorEmail
    environment.GIT_COMMITTER_NAME = daemonAuthorName
    environment.GIT_COMMITTER_EMAIL = daemonAuthorEmail

    const process = Bun.spawn(["git", ...args], {
      cwd: store.git.dir,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
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
    return createResultError(op, errorMessage(error), args.join(" "))
  }
}

async function projectRepositoryCommitGit(store: GitProjectRepository, message: string): PromiseResult<string> {
  const statusR = await gitStoreRun(store.git, ["status", "--porcelain"])
  if (!statusR.success) return statusR
  if (statusR.data.trim() === "") return createResult("")

  const commitR = await projectRepositoryGitRunWithDaemonIdentity(store, ["commit", "-m", message])
  if (!commitR.success) return commitR
  const revisionR = await gitStoreRun(store.git, ["rev-parse", "HEAD"])
  if (!revisionR.success) return revisionR
  return projectRevisionValidate(revisionR.data.trim(), "projectRepositoryCommitGit")
}

async function projectRepositoryWrite(
  store: GitProjectRepository,
  relPath: string,
  data: unknown,
  message: string,
): PromiseResult<string> {
  const segments = relPath.split("/")
  const fileName = segments.pop()
  if (!fileName) return createResultError("projectRepositoryWrite", "project path must name a file", relPath)

  const parentR = await projectRepositoryParentDirectory(store, segments.join("/"))
  if (!parentR.success) return parentR

  const absolutePath = join(parentR.data, fileName)
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    fileHandle = await open(
      absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o666,
    )
    await fileHandle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8")
  } catch (error) {
    return createResultError("projectRepositoryWrite", errorMessage(error), relPath)
  } finally {
    await fileHandle?.close()
  }

  const addR = await gitStoreRun(store.git, ["add", "--", relPath])
  if (!addR.success) return addR
  return projectRepositoryCommitGit(store, message)
}

async function projectRepositoryClearTrackedFlags(store: GitProjectRepository, relPath: string): PromiseResult<void> {
  const op = "projectRepositoryClearTrackedFlags"
  const assumeUnchangedR = await gitStoreRun(store.git, ["update-index", "--no-assume-unchanged", "--", relPath])
  if (!assumeUnchangedR.success) return createResultError(op, assumeUnchangedR.errorMessage, relPath)

  const skipWorktreeR = await gitStoreRun(store.git, ["update-index", "--no-skip-worktree", "--", relPath])
  if (!skipWorktreeR.success) return createResultError(op, skipWorktreeR.errorMessage, relPath)

  return createResult(undefined)
}

function projectRepositoryPathKey(relPath: string): Result<ProjectKey> {
  const op = "projectRepositoryRead"
  const match = /^projects\/([^/]+)\/([^/]+)\.json$/.exec(relPath)
  if (!match) return createResultError(op, "invalid project path", relPath)

  const owner = match[1]
  const name = match[2]
  if (owner === undefined || name === undefined) return createResultError(op, "invalid project path", relPath)

  const pathR = projectRepositoryPath({ owner, name })
  if (!pathR.success) return createResultError(op, pathR.errorMessage, relPath)
  if (pathR.data !== relPath) return createResultError(op, "invalid project path", relPath)
  return createResult({ owner, name })
}

function projectRepositoryUserDefaultDomainPathOwner(relPath: string): Result<string> {
  const op = "projectRepositoryRead"
  const match = /^users\/([^/]+)\/default-domain\.json$/.exec(relPath)
  const owner = match?.[1]
  if (owner === undefined) return createResultError(op, "invalid user default-domain path", relPath)

  const pathR = userDefaultDomainPath(owner)
  if (!pathR.success) return createResultError(op, pathR.errorMessage, relPath)
  if (pathR.data !== relPath) return createResultError(op, "invalid user default-domain path", relPath)
  return createResult(owner)
}

async function projectRepositoryReadUserDefaultDomains(
  store: GitProjectRepository,
): PromiseResult<UserDefaultDomain[]> {
  const op = "projectRepositoryRead"
  const safeR = await projectRepositoryUsersSafe(store)
  if (!safeR.success) return safeR

  const listR = await gitStoreList(store.git, "users")
  if (!listR.success) return listR

  const trackedR = await projectRepositoryTrackedPaths(store)
  if (!trackedR.success) return trackedR

  const domains: UserDefaultDomain[] = []
  for (const relPath of listR.data) {
    if (!trackedR.data.has(relPath)) {
      return createResultError(op, `${relPath}: user default-domain file is not tracked by Git`, relPath)
    }

    const ownerR = projectRepositoryUserDefaultDomainPathOwner(relPath)
    if (!ownerR.success) return ownerR

    const domainR = await gitStoreRead(store.git, relPath, userDefaultDomainSchema)
    if (!domainR.success) return createResultError(op, `${relPath}: ${domainR.errorMessage}`, relPath)

    const validatedR = userDefaultDomainValidate(domainR.data)
    if (!validatedR.success) return createResultError(op, `${relPath}: ${validatedR.errorMessage}`, relPath)
    if (validatedR.data.owner !== ownerR.data) {
      return createResultError(op, `${relPath}: user does not match its path`, relPath)
    }
    domains.push(validatedR.data)
  }
  return createResult(domains)
}

async function projectRepositoryReadUserDefaultDomain(
  store: GitProjectRepository,
  owner: string,
): PromiseResult<UserDefaultDomain | undefined> {
  const op = "projectRepositoryUserDefaultDomainRead"
  const pathR = userDefaultDomainPath(owner)
  if (!pathR.success) return pathR

  let pathStat: Awaited<ReturnType<typeof lstat>>
  try {
    pathStat = await lstat(join(store.git.dir, pathR.data))
  } catch (error) {
    if (projectRepositoryMissing(error)) return createResult(undefined)
    return createResultError(op, errorMessage(error), pathR.data)
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    return createResultError(op, "user default-domain path must be a regular file", pathR.data)
  }

  const domainR = await gitStoreRead(store.git, pathR.data, userDefaultDomainSchema)
  if (!domainR.success) return domainR
  const validatedR = userDefaultDomainValidate(domainR.data)
  if (!validatedR.success) return validatedR
  if (validatedR.data.owner !== owner) return createResultError(op, "user does not match its path", pathR.data)
  return createResult(validatedR.data)
}

async function projectRepositoryReadSnapshot(store: GitProjectRepository): PromiseResult<ProjectRepositorySnapshot> {
  const op = "projectRepositoryRead"
  const safeR = await projectRepositoryProjectsSafe(store)
  if (!safeR.success) return safeR
  const usersSafeR = await projectRepositoryUsersSafe(store)
  if (!usersSafeR.success) return usersSafeR

  const cleanR = await projectRepositoryRequireClean(store, op)
  if (!cleanR.success) return cleanR

  const listR = await gitStoreList(store.git, "projects")
  if (!listR.success) return listR

  const trackedR = await projectRepositoryTrackedPaths(store)
  if (!trackedR.success) return trackedR

  const projects: Project[] = []
  for (const relPath of listR.data) {
    if (!trackedR.data.has(relPath)) {
      return createResultError(op, `${relPath}: project file is not tracked by Git`, relPath)
    }

    const keyR = projectRepositoryPathKey(relPath)
    if (!keyR.success) return keyR

    const projectR = await gitStoreRead(store.git, relPath, a.unknown())
    if (!projectR.success) {
      return createResultError(op, `${relPath}: ${projectR.errorMessage}`, relPath)
    }

    const validatedR = projectMigrate(projectR.data)
    if (!validatedR.success) {
      return createResultError(op, `${relPath}: ${validatedR.errorMessage}`, relPath)
    }

    if (!projectKeyEqual(validatedR.data, keyR.data)) {
      return createResultError(op, `${relPath}: project owner/name does not match its path`, relPath)
    }
    projects.push(validatedR.data)
  }

  const collisionsR = projectCollisions(projects)
  if (!collisionsR.success) return createResultError(op, collisionsR.errorMessage)

  const domainsR = await projectRepositoryReadUserDefaultDomains(store)
  if (!domainsR.success) return domainsR

  const revisionR = await projectRepositoryRevision(store)
  if (!revisionR.success) return revisionR
  return createResult({ projects, revision: revisionR.data })
}

function projectRepositoryContentsEqual(left: unknown, right: unknown): boolean {
  const serialize = (value: unknown): string =>
    JSON.stringify(value, (_, nested) => {
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested
      return Object.fromEntries(Object.entries(nested).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)))
    })
  return serialize(left) === serialize(right)
}

type ProjectRepositoryMigrationRecord = {
  canonical: boolean
  path: string
  project: ProjectCanonical
}

type ProjectRepositoryMigrationGrouping = ProjectRepositoryServiceGrouping & { serviceId: string }

type ProjectRepositoryMigrationPlan = {
  records: ProjectRepositoryMigrationRecord[]
  projects: ProjectCanonical[]
  writes: Array<{ data: string; path: string }>
  removals: string[]
  canonicalized: number
  grouped: Array<{
    parent: ProjectKey
    serviceId: string
    source: ProjectKey
  }>
  removed: ProjectKey[]
}

const projectRepositoryMigrationServiceIdPattern = /^[a-z0-9][a-z0-9-]*$/
const projectRepositoryMigrationMetadataKeys = [
  "description",
  "order",
  "github",
  "previewUrl",
  "previewPort",
  "productionUrl",
  "productionAssetsUrl",
] as const

function projectRepositoryMigrationKey(key: ProjectKey): string {
  return `${key.owner}\u0000${key.name}`
}

function projectRepositoryMigrationKeyEqual(left: ProjectKey, right: ProjectKey): boolean {
  return left.owner === right.owner && left.name === right.name
}

function projectRepositoryMigrationMetadataValue(
  project: ProjectCanonical,
  key: (typeof projectRepositoryMigrationMetadataKeys)[number],
): unknown {
  const value = project[key]
  if (key === "order" && value === Number.MAX_SAFE_INTEGER) return undefined
  return value
}

function projectRepositoryMigrationMetadataMerge(
  parent: ProjectCanonical,
  source: ProjectCanonical,
): Result<ProjectCanonical> {
  const op = "projectRepositoryMigration"
  const merged: ProjectCanonical = { ...parent, labels: { ...parent.labels }, services: [...parent.services] }

  for (const key of projectRepositoryMigrationMetadataKeys) {
    const sourceValue = projectRepositoryMigrationMetadataValue(source, key)
    if (sourceValue === undefined) continue

    const parentValue = projectRepositoryMigrationMetadataValue(parent, key)
    if (parentValue === undefined) {
      Object.assign(merged, { [key]: sourceValue })
      continue
    }
    if (parentValue !== sourceValue) {
      return createResultErrorCode(
        op,
        `cannot group ${source.owner}/${source.name} into ${parent.owner}/${parent.name}: project metadata ${key} conflicts`,
        "projects.conflict",
      )
    }
  }

  for (const [key, value] of Object.entries(source.labels)) {
    const parentValue = merged.labels[key]
    if (parentValue !== undefined && parentValue !== value) {
      return createResultErrorCode(
        op,
        `cannot group ${source.owner}/${source.name} into ${parent.owner}/${parent.name}: label ${key} conflicts`,
        "projects.conflict",
      )
    }
    Object.defineProperty(merged.labels, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }

  return createResult(merged)
}

function projectRepositoryMigrationServices(source: ProjectCanonical, serviceId: string): Result<ProjectService[]> {
  const op = "projectRepositoryMigration"
  const services: ProjectService[] = []
  const sourceServices = source.services
  for (let index = 0; index < sourceServices.length; index += 1) {
    const sourceService = sourceServices[index]
    if (sourceService === undefined) continue
    const id = sourceServices.length === 1 ? serviceId : `${serviceId}-${sourceService.id}`
    if (!projectRepositoryMigrationServiceIdPattern.test(id)) {
      return createResultErrorCode(op, `invalid grouped service ID: ${id}`, "request.invalid")
    }
    if (services.some((service) => service.id === id)) {
      return createResultErrorCode(op, `duplicate grouped service ID: ${id}`, "projects.conflict")
    }
    services.push({
      id,
      units: [...sourceService.units],
      caddy: sourceService.caddy,
      ownership: sourceService.ownership,
    })
  }
  return createResult(services)
}

function projectRepositoryMigrationGroupingNormalize(input: unknown): Result<ProjectRepositoryMigrationGrouping[]> {
  const op = "projectRepositoryMigration"
  if (!Array.isArray(input)) return createResultError(op, "groupings must be an array")

  const normalized: ProjectRepositoryMigrationGrouping[] = []
  const sources = new Set<string>()
  for (const value of input) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return createResultError(op, "each grouping must be an object")
    }
    const grouping = value as Record<string, unknown>
    const source = grouping.source
    const parent = grouping.parent
    if (
      source === null ||
      typeof source !== "object" ||
      Array.isArray(source) ||
      parent === null ||
      typeof parent !== "object" ||
      Array.isArray(parent)
    ) {
      return createResultError(op, "each grouping needs source and parent project keys")
    }

    const sourceKey = source as Record<string, unknown>
    const parentKey = parent as Record<string, unknown>
    if (
      typeof sourceKey.owner !== "string" ||
      typeof sourceKey.name !== "string" ||
      typeof parentKey.owner !== "string" ||
      typeof parentKey.name !== "string"
    ) {
      return createResultError(op, "grouping project keys must contain owner and name strings")
    }

    const sourceProjectKey = { owner: sourceKey.owner, name: sourceKey.name }
    const parentProjectKey = { owner: parentKey.owner, name: parentKey.name }
    const sourcePathR = projectRepositoryPath(sourceProjectKey)
    if (!sourcePathR.success) return sourcePathR
    const parentPathR = projectRepositoryPath(parentProjectKey)
    if (!parentPathR.success) return parentPathR
    if (projectRepositoryMigrationKeyEqual(sourceProjectKey, parentProjectKey)) {
      return createResultErrorCode(op, "a grouping source and parent must differ", "request.invalid")
    }

    const key = projectRepositoryMigrationKey(sourceProjectKey)
    if (sources.has(key)) return createResultErrorCode(op, `grouping source is repeated: ${key}`, "request.invalid")
    sources.add(key)

    const requestedServiceId = grouping.serviceId
    const serviceId = requestedServiceId === undefined ? sourceProjectKey.name : requestedServiceId
    if (typeof serviceId !== "string" || !projectRepositoryMigrationServiceIdPattern.test(serviceId)) {
      return createResultErrorCode(op, `invalid grouped service ID: ${String(serviceId)}`, "request.invalid")
    }
    normalized.push({ source: sourceProjectKey, parent: parentProjectKey, serviceId })
  }

  normalized.sort((left, right) => {
    const parentOrder = projectRepositoryMigrationKey(left.parent).localeCompare(
      projectRepositoryMigrationKey(right.parent),
    )
    if (parentOrder !== 0) return parentOrder
    return projectRepositoryMigrationKey(left.source).localeCompare(projectRepositoryMigrationKey(right.source))
  })

  const sourcesAsParents = new Set(normalized.map((grouping) => projectRepositoryMigrationKey(grouping.source)))
  for (const grouping of normalized) {
    if (sourcesAsParents.has(projectRepositoryMigrationKey(grouping.parent))) {
      return createResultErrorCode(
        op,
        `grouping parent is also a grouping source: ${projectRepositoryMigrationKey(grouping.parent)}`,
        "request.invalid",
      )
    }
  }

  return createResult(normalized)
}

async function projectRepositoryMigrationRecords(
  store: GitProjectRepository,
  snapshot: ProjectRepositorySnapshot,
): PromiseResult<ProjectRepositoryMigrationRecord[]> {
  const records: ProjectRepositoryMigrationRecord[] = []
  for (const project of snapshot.projects) {
    const migratedR = projectMigrate(project)
    if (!migratedR.success) return createResultError("projectRepositoryMigration", migratedR.errorMessage)
    const migrated = migratedR.data
    const pathR = projectRepositoryPath(migrated)
    if (!pathR.success) return pathR
    const rawR = await gitStoreRead(store.git, pathR.data, a.unknown())
    if (!rawR.success) return createResultError("projectRepositoryMigration", rawR.errorMessage, pathR.data)
    const raw = rawR.data
    const canonical =
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).schemaVersion === 2 &&
      !Object.hasOwn(raw, "type")
    records.push({ canonical, path: pathR.data, project: migrated })
  }
  return createResult(records)
}

async function projectRepositoryMigrationPlanBuild(
  store: GitProjectRepository,
  snapshot: ProjectRepositorySnapshot,
  options: ProjectRepositoryMigrationOptions,
): PromiseResult<ProjectRepositoryMigrationPlan> {
  const op = "projectRepositoryMigration"
  const recordsR = await projectRepositoryMigrationRecords(store, snapshot)
  if (!recordsR.success) return recordsR
  const groupingsR = projectRepositoryMigrationGroupingNormalize(options.groupings ?? [])
  if (!groupingsR.success) return groupingsR
  const groupings = groupingsR.data
  const byKey = new Map(recordsR.data.map((record) => [projectRepositoryMigrationKey(record.project), record.project]))
  const working = new Map(byKey)
  const removals = new Set<string>()
  const removed = new Map<string, ProjectKey>()
  const grouped: Array<{ parent: ProjectKey; serviceId: string; source: ProjectKey }> = []

  for (const grouping of groupings) {
    const sourceKey = projectRepositoryMigrationKey(grouping.source)
    const parentKey = projectRepositoryMigrationKey(grouping.parent)
    const source = byKey.get(sourceKey)
    const parent = working.get(parentKey)
    if (parent === undefined) {
      return createResultErrorCode(op, `grouping parent does not exist: ${parentKey}`, "projects.not-found")
    }

    if (source === undefined) {
      if (!parent.services.some((service) => service.id === grouping.serviceId)) {
        return createResultErrorCode(op, `grouping source is missing: ${sourceKey}`, "projects.not-found")
      }
      grouped.push({ parent: grouping.parent, serviceId: grouping.serviceId, source: grouping.source })
      continue
    }

    const metadataR = projectRepositoryMigrationMetadataMerge(parent, source)
    if (!metadataR.success) return metadataR
    const sourceServicesR = projectRepositoryMigrationServices(source, grouping.serviceId)
    if (!sourceServicesR.success) return sourceServicesR
    const existingIds = new Set(parent.services.map((service) => service.id))
    for (const service of sourceServicesR.data) {
      if (existingIds.has(service.id)) {
        return createResultErrorCode(
          op,
          `cannot group ${sourceKey} into ${parentKey}: service ID ${service.id} already exists`,
          "projects.conflict",
        )
      }
      existingIds.add(service.id)
    }

    const merged = metadataR.data
    merged.services = [...parent.services, ...sourceServicesR.data]
    working.set(parentKey, merged)
    removals.add(sourceKey)
    removed.set(sourceKey, grouping.source)
    grouped.push({ parent: grouping.parent, serviceId: grouping.serviceId, source: grouping.source })
  }

  const projects = recordsR.data
    .map((record) => working.get(projectRepositoryMigrationKey(record.project)))
    .filter((project): project is ProjectCanonical => project !== undefined)
    .filter((project) => !removals.has(projectRepositoryMigrationKey(project)))

  const collisionsR = projectCollisions(projects)
  if (!collisionsR.success) return createResultError(op, collisionsR.errorMessage)
  const caddyR = caddyConfigGenerate(projects)
  if (!caddyR.success) return createResultError(op, `generated Caddy configuration is invalid: ${caddyR.errorMessage}`)
  const caddySerializedR = caddyConfigSerialize(caddyR.data)
  if (!caddySerializedR.success) {
    return createResultError(op, `generated Caddy configuration is invalid: ${caddySerializedR.errorMessage}`)
  }

  const projectByPath = new Map(recordsR.data.map((record) => [record.path, record]))
  const writes: Array<{ data: string; path: string }> = []
  for (const record of recordsR.data) {
    const key = projectRepositoryMigrationKey(record.project)
    if (removals.has(key)) continue
    const project = working.get(key)
    if (project === undefined) return createResultError(op, `migration lost project ${key}`)
    const groupedParent = grouped.some((entry) => projectRepositoryMigrationKey(entry.parent) === key)
    if (!record.canonical || groupedParent) {
      const data = `${JSON.stringify(project, null, 2)}\n`
      if (!record.canonical || !projectRepositoryContentsEqual(project, projectByPath.get(record.path)?.project)) {
        writes.push({ data, path: record.path })
      }
    }
  }

  const removalPaths = recordsR.data
    .filter((record) => removals.has(projectRepositoryMigrationKey(record.project)))
    .map((record) => record.path)
    .sort()

  return createResult({
    canonicalized: recordsR.data.filter((record) => !record.canonical).length,
    grouped,
    projects,
    records: recordsR.data,
    removed: [...removed.values()],
    removals: removalPaths,
    writes,
  })
}

function projectRepositoryMigrationNoop(
  dryRun: boolean,
  changed: boolean,
  revision: string,
  plan: ProjectRepositoryMigrationPlan,
): Result<ProjectRepositoryMigration> {
  return createResult({
    changed,
    canonicalized: plan.canonicalized,
    grouped: plan.grouped,
    removed: plan.removed,
    revision,
    dryRun,
    localCommit: { status: "unchanged", revision },
    push: { requested: false, status: "not-requested" },
  })
}

async function projectRepositoryMigrationStageWrite(
  directory: string,
  path: string,
  data: string,
): PromiseResult<string> {
  const op = "projectRepositoryMigration"
  const stagePath = join(directory, path)
  const parent = stagePath.slice(0, stagePath.lastIndexOf("/"))
  try {
    await mkdir(parent, { recursive: true })
    const handle = await open(
      stagePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o666,
    )
    try {
      await handle.writeFile(data, "utf8")
    } finally {
      await handle.close()
    }
  } catch (error) {
    return createResultError(op, errorMessage(error), path)
  }
  return createResult(stagePath)
}

async function projectRepositoryMigrationRollback(store: GitProjectRepository): PromiseResult<void> {
  const resetR = await gitStoreRun(store.git, ["reset", "--hard", "HEAD"])
  if (!resetR.success) return resetR
  return createResult(undefined)
}

async function projectRepositoryMigrationCommit(
  store: GitProjectRepository,
  plan: ProjectRepositoryMigrationPlan,
  actor: string,
  expectedRevision: string,
): PromiseResult<ProjectRepositoryMigration> {
  const op = "projectRepositoryMigration"
  const branchR = await projectRepositoryRequireConfiguredBranch(store.git, op)
  if (!branchR.success) return branchR
  const currentRevisionR = await projectRepositoryRevision(store)
  if (!currentRevisionR.success) return currentRevisionR
  if (currentRevisionR.data !== expectedRevision) {
    return createResultError(
      op,
      `revision changed during migration: expected ${expectedRevision}, current ${currentRevisionR.data}`,
    )
  }
  const cleanR = await projectRepositoryRequireClean(store, op)
  if (!cleanR.success) return cleanR

  const safeR = await projectRepositoryProjectsSafe(store)
  if (!safeR.success) return safeR
  let stagingDirectory: string | undefined
  let committed = false
  try {
    stagingDirectory = await mkdtemp(join(store.git.dir, ".project-registry-migration-"))
    const stagedPaths: string[] = []
    for (const write of plan.writes) {
      const stagedR = await projectRepositoryMigrationStageWrite(stagingDirectory, write.path, write.data)
      if (!stagedR.success) return stagedR
      stagedPaths.push(write.path)
    }

    for (const write of plan.writes) {
      await rename(join(stagingDirectory, write.path), join(store.git.dir, write.path))
    }

    if (plan.removals.length > 0) {
      const removeR = await gitStoreRun(store.git, ["rm", "-f", "--", ...plan.removals])
      if (!removeR.success) return removeR
    }
    if (stagedPaths.length > 0) {
      const addR = await gitStoreRun(store.git, ["add", "--", ...stagedPaths])
      if (!addR.success) return addR
    }

    const commitR = await projectRepositoryCommitGit(store, `project-registry migrate multi-service actor=${actor}`)
    if (!commitR.success) return commitR
    committed = true
    const revision = commitR.data.trim()
    if (revision === "") return createResultError(op, "migration did not produce a local commit")

    const result = {
      changed: true,
      canonicalized: plan.canonicalized,
      grouped: plan.grouped,
      removed: plan.removed,
      revision,
      dryRun: false,
      localCommit: { status: "committed" as const, revision },
      push: { requested: false as const, status: "not-requested" as const },
    }
    if (!store.autoPush) return createResult(result)

    const pushR = await projectRepositoryPush(store, revision, op)
    if (!pushR.success) {
      return createResult({
        ...result,
        push: { requested: true, status: "failed", errorMessage: pushR.errorMessage },
      })
    }
    return createResult({ ...result, push: { requested: true, status: "pushed" } })
  } catch (error) {
    return createResultError(op, errorMessage(error))
  } finally {
    if (!committed) await projectRepositoryMigrationRollback(store)
    if (stagingDirectory !== undefined) await rm(stagingDirectory, { force: true, recursive: true })
  }
}

async function projectRepositoryMigrate(
  store: GitProjectRepository,
  options: ProjectRepositoryMigrationOptions,
): PromiseResult<ProjectRepositoryMigration> {
  const op = "projectRepositoryMigration"
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return createResultError(op, "migration options must be an object")
  }
  if (typeof options.dryRun !== "undefined" && typeof options.dryRun !== "boolean") {
    return createResultError(op, "dryRun must be a boolean")
  }
  const actorR = projectRepositoryActor(options, op)
  if (!actorR.success) return actorR

  const snapshotR = await projectRepositoryReadSnapshot(store)
  if (!snapshotR.success) return snapshotR
  if (options.expectedRevision !== undefined) {
    const expectedR = projectRepositoryExpectedRevision(options, snapshotR.data.revision, op)
    if (!expectedR.success) return expectedR
  }

  const planR = await projectRepositoryMigrationPlanBuild(store, snapshotR.data, options)
  if (!planR.success) return planR
  const plan = planR.data
  const changed = plan.writes.length > 0 || plan.removals.length > 0
  const dryRun = options.dryRun ?? false
  if (!changed || dryRun) return projectRepositoryMigrationNoop(dryRun, changed, snapshotR.data.revision, plan)
  return projectRepositoryMigrationCommit(store, plan, actorR.data, snapshotR.data.revision)
}

async function projectRepositoryFileCanonical(store: GitProjectRepository, relPath: string): PromiseResult<boolean> {
  const projectR = await gitStoreRead(store.git, relPath, a.unknown())
  if (!projectR.success) return projectR
  return createResult(
    typeof projectR.data === "object" &&
      projectR.data !== null &&
      !Array.isArray(projectR.data) &&
      (projectR.data as Record<string, unknown>).schemaVersion === 2,
  )
}

function projectRepositoryActor(options: { actor?: unknown }, op: string): Result<string> {
  if (!options || typeof options.actor !== "string") {
    return createResultError(op, "actor is required")
  }
  const actor = options.actor
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (actor === "") return createResultError(op, "actor is required")
  if (
    [...actor].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    })
  ) {
    return createResultError(op, "actor must not contain control characters")
  }
  return createResult(actor)
}

function projectRepositoryHistoryDeduplicate(commits: GitStoreCommitInfo[], limit?: number): GitStoreCommitInfo[] {
  const seen = new Set<string>()
  const unique: GitStoreCommitInfo[] = []
  for (const commit of commits) {
    if (seen.has(commit.sha)) continue
    seen.add(commit.sha)
    unique.push(commit)
    if (limit !== undefined && unique.length >= limit) break
  }
  return unique
}

function projectRepositoryMutationKey(key: ProjectKey): ProjectKey {
  return { owner: key.owner, name: key.name }
}

function projectRepositoryCommitMessage(
  action: ProjectRepositoryMutation["action"],
  key: ProjectKey,
  actor: string,
): string {
  return `project-registry ${action} ${key.owner}/${key.name} actor=${actor}`
}

function projectRepositoryNoop(
  action: ProjectRepositoryMutation["action"],
  key: ProjectKey,
  revision: string,
): Result<ProjectRepositoryMutation> {
  return createResult({
    action,
    key: projectRepositoryMutationKey(key),
    changed: false,
    revision,
    localCommit: { status: "unchanged", revision },
    push: { requested: false, status: "not-requested" },
  })
}

async function projectRepositoryConfiguredUpstream(
  store: GitProjectRepository,
  op: string,
): PromiseResult<ProjectRepositoryUpstream> {
  const remoteR = await gitStoreRun(store.git, ["config", "--get", `branch.${store.git.branch}.remote`])
  if (!remoteR.success) return createResultError(op, "configured upstream remote is missing")
  const mergeR = await gitStoreRun(store.git, ["config", "--get", `branch.${store.git.branch}.merge`])
  if (!mergeR.success) return createResultError(op, "configured upstream ref is missing")

  const remote = remoteR.data.trim()
  const ref = mergeR.data.trim()
  if (remote === "") return createResultError(op, "configured upstream remote is empty")
  if (ref === "" || !ref.startsWith("refs/")) return createResultError(op, "configured upstream ref is invalid")
  return createResult({ remote, ref })
}

function projectRepositoryPushTargetMatches(output: string, revision: string, ref: string): boolean {
  for (const line of output.trim().split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] === revision && fields[1] === ref) return true
  }
  return false
}

async function projectRepositoryPush(store: GitProjectRepository, revision: string, op: string): PromiseResult<void> {
  const upstreamR = await projectRepositoryConfiguredUpstream(store, op)
  if (!upstreamR.success) return upstreamR
  const { remote, ref } = upstreamR.data

  const pushR = await gitStoreRun(store.git, ["push", remote, `${revision}:${ref}`])
  if (!pushR.success) return pushR

  const pushUrlR = await gitStoreRun(store.git, ["remote", "get-url", "--push", remote])
  const targetRepository = pushUrlR.success ? pushUrlR.data.trim() : remote
  const targetR = await gitStoreRun(store.git, ["ls-remote", targetRepository, ref])
  if (!targetR.success) return targetR
  if (!projectRepositoryPushTargetMatches(targetR.data, revision, ref)) {
    return createResultError(op, `upstream ${remote}/${ref} does not reach committed revision ${revision}`)
  }
  return createResult(undefined)
}

async function projectRepositoryCommit(
  store: GitProjectRepository,
  action: ProjectRepositoryMutation["action"],
  key: ProjectKey,
  actor: string,
  relPath: string,
  project: Project | undefined,
  expectedRevision: string,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectRepositoryMutation"
  const branchR = await projectRepositoryRequireConfiguredBranch(store.git, op)
  if (!branchR.success) return branchR

  const currentRevisionR = await projectRepositoryRevision(store)
  if (!currentRevisionR.success) return currentRevisionR
  if (currentRevisionR.data !== expectedRevision) {
    return createResultError(
      op,
      `revision changed during mutation: expected ${expectedRevision}, current ${currentRevisionR.data}`,
    )
  }

  const message = projectRepositoryCommitMessage(action, key, actor)
  const safeR = await projectRepositoryProjectsSafe(store)
  if (!safeR.success) return safeR

  if (action !== "create") {
    const clearFlagsR = await projectRepositoryClearTrackedFlags(store, relPath)
    if (!clearFlagsR.success) return clearFlagsR
  }

  let commitR: Result<string>
  if (action === "delete") {
    const removeR = await gitStoreRun(store.git, ["rm", "-f", "--", relPath])
    if (!removeR.success) return removeR
    commitR = await projectRepositoryCommitGit(store, message)
  } else {
    if (project === undefined) return createResultError(op, "project data is required", relPath)
    commitR = await projectRepositoryWrite(store, relPath, project, message)
  }
  if (!commitR.success) {
    return createResultError(op, `${action} commit failed: ${commitR.errorMessage}`, relPath)
  }

  const revision = commitR.data.trim()
  if (revision === "") return createResultError(op, `${action} did not produce a local commit`, relPath)

  if (!store.autoPush) {
    return createResult({
      action,
      key: projectRepositoryMutationKey(key),
      changed: true,
      revision,
      localCommit: { status: "committed", revision },
      push: { requested: false, status: "not-requested" },
    })
  }

  const pushR = await projectRepositoryPush(store, revision, op)
  if (!pushR.success) {
    return createResult({
      action,
      key: projectRepositoryMutationKey(key),
      changed: true,
      revision,
      localCommit: { status: "committed", revision },
      push: { requested: true, status: "failed", errorMessage: pushR.errorMessage },
    })
  }

  return createResult({
    action,
    key: projectRepositoryMutationKey(key),
    changed: true,
    revision,
    localCommit: { status: "committed", revision },
    push: { requested: true, status: "pushed" },
  })
}

function projectRepositoryUserDefaultDomainNoop(
  owner: string,
  domain: string | null,
  revision: string,
): Result<UserDefaultDomainMutation> {
  const action = domain === null ? "unset" : "set"
  return createResult({
    action,
    owner,
    domain,
    changed: false,
    revision,
    localCommit: { status: "unchanged", revision },
    push: { requested: false, status: "not-requested" },
  })
}

async function projectRepositoryUserDefaultDomainCommit(
  store: GitProjectRepository,
  owner: string,
  domain: UserDefaultDomain,
  actor: string,
  path: string,
  existing: boolean,
  expectedRevision: string,
): PromiseResult<UserDefaultDomainMutation> {
  const op = "projectRepositoryUserDefaultDomainMutation"
  const action = domain.domain === null ? "unset" : "set"
  const branchR = await projectRepositoryRequireConfiguredBranch(store.git, op)
  if (!branchR.success) return branchR

  const currentRevisionR = await projectRepositoryRevision(store)
  if (!currentRevisionR.success) return currentRevisionR
  if (currentRevisionR.data !== expectedRevision) {
    return createResultError(
      op,
      `revision changed during mutation: expected ${expectedRevision}, current ${currentRevisionR.data}`,
    )
  }

  const safeR = await projectRepositoryUsersSafe(store)
  if (!safeR.success) return safeR
  if (existing) {
    const clearFlagsR = await projectRepositoryClearTrackedFlags(store, path)
    if (!clearFlagsR.success) return clearFlagsR
  }

  const commitR = await projectRepositoryWrite(
    store,
    path,
    domain,
    `project-registry ${action}-default-domain ${owner} actor=${actor}`,
  )
  if (!commitR.success) return createResultError(op, `${action} commit failed: ${commitR.errorMessage}`, path)

  const revision = commitR.data.trim()
  if (revision === "") return createResultError(op, `${action} did not produce a local commit`, path)

  if (!store.autoPush) {
    return createResult({
      action,
      owner,
      domain: domain.domain,
      changed: true,
      revision,
      localCommit: { status: "committed", revision },
      push: { requested: false, status: "not-requested" },
    })
  }

  const pushR = await projectRepositoryPush(store, revision, op)
  if (!pushR.success) {
    return createResult({
      action,
      owner,
      domain: domain.domain,
      changed: true,
      revision,
      localCommit: { status: "committed", revision },
      push: { requested: true, status: "failed", errorMessage: pushR.errorMessage },
    })
  }

  return createResult({
    action,
    owner,
    domain: domain.domain,
    changed: true,
    revision,
    localCommit: { status: "committed", revision },
    push: { requested: true, status: "pushed" },
  })
}

function projectRepositoryExpectedRevision(options: unknown, currentRevision: unknown, op: string): Result<void> {
  const expectedR = projectMutationExpectedRevision(options, currentRevision, op)
  if (!expectedR.success) return expectedR
  if (expectedR.data !== currentRevision) {
    return createResultErrorCode(
      op,
      `revision mismatch: expected ${expectedR.data}, current ${currentRevision}`,
      "projects.conflict",
    )
  }
  return createResult(undefined)
}

async function projectRepositoryCreate(
  store: GitProjectRepository,
  input: unknown,
  options: ProjectRepositoryMutationOptions,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectRepositoryCreate"
  const snapshotR = await projectRepositoryReadSnapshot(store)
  if (!snapshotR.success) return snapshotR

  const expectedR = projectRepositoryExpectedRevision(options, snapshotR.data.revision, op)
  if (!expectedR.success) return expectedR
  const actorR = projectRepositoryActor(options, op)
  if (!actorR.success) return actorR

  const projectR = projectMigrate(input)
  if (!projectR.success) return { ...projectR, op }
  const project = projectR.data
  const existing = snapshotR.data.projects.find((item) => projectKeyEqual(item, project))
  if (existing) {
    if (projectRepositoryContentsEqual(existing, project))
      return projectRepositoryNoop("create", project, snapshotR.data.revision)
    return createResultErrorCode(op, "project already exists", "projects.conflict")
  }

  const collisionsR = projectCollisions([...snapshotR.data.projects, project])
  if (!collisionsR.success) return { ...collisionsR, op }
  const pathR = projectRepositoryPath(project)
  if (!pathR.success) return pathR
  return projectRepositoryCommit(store, "create", project, actorR.data, pathR.data, project, snapshotR.data.revision)
}

async function projectRepositoryEdit(
  store: GitProjectRepository,
  key: ProjectKey,
  input: unknown,
  options: ProjectRepositoryMutationOptions,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectRepositoryEdit"
  const pathR = projectRepositoryPath(key)
  if (!pathR.success) return pathR

  const snapshotR = await projectRepositoryReadSnapshot(store)
  if (!snapshotR.success) return snapshotR

  const expectedR = projectRepositoryExpectedRevision(options, snapshotR.data.revision, op)
  if (!expectedR.success) return expectedR
  const actorR = projectRepositoryActor(options, op)
  if (!actorR.success) return actorR

  const projectR = projectMigrate(input)
  if (!projectR.success) return { ...projectR, op }
  const project = projectR.data
  if (!projectKeyEqual(project, key))
    return createResultErrorCode(op, "project owner and name are immutable", "request.invalid")

  const existing = snapshotR.data.projects.find((item) => projectKeyEqual(item, key))
  if (!existing) return createResultErrorCode(op, "project not found", "projects.not-found")
  if (projectRepositoryContentsEqual(existing, project)) {
    const canonicalR = await projectRepositoryFileCanonical(store, pathR.data)
    if (!canonicalR.success) return canonicalR
    if (canonicalR.data) return projectRepositoryNoop("edit", project, snapshotR.data.revision)
  }

  const replacement = snapshotR.data.projects.map((item) => (projectKeyEqual(item, key) ? project : item))
  const collisionsR = projectCollisions(replacement)
  if (!collisionsR.success) return { ...collisionsR, op }
  return projectRepositoryCommit(store, "edit", key, actorR.data, pathR.data, project, snapshotR.data.revision)
}

async function projectRepositoryDelete(
  store: GitProjectRepository,
  key: ProjectKey,
  options: ProjectRepositoryMutationOptions,
): PromiseResult<ProjectRepositoryMutation> {
  const op = "projectRepositoryDelete"
  const pathR = projectRepositoryPath(key)
  if (!pathR.success) return pathR

  const snapshotR = await projectRepositoryReadSnapshot(store)
  if (!snapshotR.success) return snapshotR

  const expectedR = projectRepositoryExpectedRevision(options, snapshotR.data.revision, op)
  if (!expectedR.success) return expectedR
  const actorR = projectRepositoryActor(options, op)
  if (!actorR.success) return actorR

  const existing = snapshotR.data.projects.find((item) => projectKeyEqual(item, key))
  if (!existing) return createResultErrorCode(op, "project not found", "projects.not-found")
  return projectRepositoryCommit(store, "delete", key, actorR.data, pathR.data, undefined, snapshotR.data.revision)
}

async function projectRepositorySetUserDefaultDomain(
  store: GitProjectRepository,
  owner: string,
  domain: string | null,
  options: ProjectRepositoryMutationOptions,
): PromiseResult<UserDefaultDomainMutation> {
  const op = "projectRepositorySetUserDefaultDomain"
  const pathR = userDefaultDomainPath(owner)
  if (!pathR.success) return pathR

  const domainR = userDefaultDomainValidate({ owner, domain })
  if (!domainR.success) return { ...domainR, op }

  const snapshotR = await projectRepositoryReadSnapshot(store)
  if (!snapshotR.success) return snapshotR

  const expectedR = projectRepositoryExpectedRevision(options, snapshotR.data.revision, op)
  if (!expectedR.success) return expectedR
  const actorR = projectRepositoryActor(options, op)
  if (!actorR.success) return actorR

  const existingR = await projectRepositoryReadUserDefaultDomain(store, owner)
  if (!existingR.success) return existingR
  if (existingR.data?.domain === domainR.data.domain) {
    return projectRepositoryUserDefaultDomainNoop(owner, domainR.data.domain, snapshotR.data.revision)
  }

  return projectRepositoryUserDefaultDomainCommit(
    store,
    owner,
    domainR.data,
    actorR.data,
    pathR.data,
    existingR.data !== undefined,
    snapshotR.data.revision,
  )
}

function projectRepositoryQueue<T>(
  store: GitProjectRepository,
  op: string,
  operation: () => PromiseResult<T>,
): PromiseResult<T> {
  const previous = mutationQueues.get(store.queueKey) ?? Promise.resolve()
  const result = previous.then(async () => {
    try {
      const branchR = await projectRepositoryRequireConfiguredBranch(store.git, op)
      if (!branchR.success) return branchR
      return await operation()
    } catch (error) {
      return createResultError(op, errorMessage(error))
    }
  })
  const queue = result.then(
    () => undefined,
    () => undefined,
  )
  mutationQueues.set(store.queueKey, queue)
  void queue.then(() => {
    if (mutationQueues.get(store.queueKey) === queue) mutationQueues.delete(store.queueKey)
  })
  return result
}

async function projectRepositoryRecover(store: GitProjectRepository): PromiseResult<ProjectRepositoryReadiness> {
  const op = "projectRepositoryRecover"
  const safeR = await projectRepositoryProjectsSafe(store)
  if (!safeR.success) return safeR
  const usersSafeR = await projectRepositoryUsersSafe(store)
  if (!usersSafeR.success) return usersSafeR

  const revisionR = await projectRepositoryRevision(store)
  if (!revisionR.success) return revisionR

  const trackedR = await projectRepositoryTrackedPaths(store)
  if (!trackedR.success) return trackedR
  if (trackedR.data.size > 0) {
    const unmarkAssumeUnchangedR = await gitStoreRun(store.git, [
      "update-index",
      "--no-assume-unchanged",
      "--",
      ...trackedR.data,
    ])
    if (!unmarkAssumeUnchangedR.success) return unmarkAssumeUnchangedR
    const unmarkSkipWorktreeR = await gitStoreRun(store.git, [
      "update-index",
      "--no-skip-worktree",
      "--",
      ...trackedR.data,
    ])
    if (!unmarkSkipWorktreeR.success) return unmarkSkipWorktreeR
  }

  if (revisionR.data !== "") {
    const resetR = await gitStoreRun(store.git, ["reset", "--hard", "HEAD"])
    if (!resetR.success) return resetR
  } else {
    const resetR = await gitStoreRun(store.git, ["reset"])
    if (!resetR.success) return resetR
  }

  const cleanR = await gitStoreRun(store.git, ["clean", "-fdx"])
  if (!cleanR.success) return cleanR

  const readinessR = await projectRepositoryReadiness(store)
  if (!readinessR.success) return readinessR
  if (!readinessR.data.ready) return createResultError(op, readinessR.data.reason ?? "worktree remains dirty")
  return readinessR
}

export async function projectRepositoryOpen(options: unknown): PromiseResult<ProjectRepository> {
  const op = "projectRepositoryOpen"
  const parsed = a.safeParse(projectRepositoryOptionsSchema, options)
  if (!parsed.success) return createResultError(op, a.summarize(parsed.issues))

  const opts = parsed.output
  const gitR = await gitStoreOpen({
    dir: opts.dir,
    branch: opts.branch,
    autoPush: false,
    authorName: daemonAuthorName,
    authorEmail: daemonAuthorEmail,
  })
  if (!gitR.success) return gitR

  const branchR = await projectRepositoryRequireConfiguredBranch(gitR.data, op)
  if (!branchR.success) return branchR

  let canonicalDir: string
  try {
    canonicalDir = await realpath(opts.dir)
  } catch (error) {
    return createResultError(op, `failed to resolve real worktree: ${errorMessage(error)}`, opts.dir)
  }

  const store: GitProjectRepository = {
    git: { ...gitR.data, dir: canonicalDir },
    autoPush: opts.autoPush,
    queueKey: canonicalDir,
  }
  const readinessR = await projectRepositoryReadiness(store)
  if (!readinessR.success) return readinessR

  const repository: ProjectRepository = {
    read: () => projectRepositoryQueue(store, "projectRepositoryRead", () => projectRepositoryReadSnapshot(store)),
    get: (key) =>
      projectRepositoryQueue(store, "projectRepositoryGet", async () => {
        const pathR = projectRepositoryPath(key)
        if (!pathR.success) return pathR
        const snapshotR = await projectRepositoryReadSnapshot(store)
        if (!snapshotR.success) return snapshotR
        const project = snapshotR.data.projects.find((item) => projectKeyEqual(item, key))
        if (!project) return createResultErrorCode("projectRepositoryGet", "project not found", "projects.not-found")
        const entry: ProjectRepositoryEntry = { project, revision: snapshotR.data.revision }
        return createResult(entry)
      }),
    getUserDefaultDomain: (owner) =>
      projectRepositoryQueue(store, "projectRepositoryUserDefaultDomainGet", async () => {
        const pathR = userDefaultDomainPath(owner)
        if (!pathR.success) return pathR
        const snapshotR = await projectRepositoryReadSnapshot(store)
        if (!snapshotR.success) return snapshotR
        const domainR = await projectRepositoryReadUserDefaultDomain(store, owner)
        if (!domainR.success) return domainR
        const entry: UserDefaultDomainEntry = {
          owner,
          domain: domainR.data?.domain,
          revision: snapshotR.data.revision,
        }
        return createResult(entry)
      }),
    create: (project, mutationOptions) =>
      projectRepositoryQueue(store, "projectRepositoryCreate", () =>
        projectRepositoryCreate(store, project, mutationOptions),
      ),
    edit: (key, project, mutationOptions) =>
      projectRepositoryQueue(store, "projectRepositoryEdit", () =>
        projectRepositoryEdit(store, key, project, mutationOptions),
      ),
    delete: (key, mutationOptions) =>
      projectRepositoryQueue(store, "projectRepositoryDelete", () =>
        projectRepositoryDelete(store, key, mutationOptions),
      ),
    migrate: (migrationOptions) =>
      projectRepositoryQueue(store, "projectRepositoryMigration", () =>
        projectRepositoryMigrate(store, migrationOptions),
      ),
    setUserDefaultDomain: (owner, domain, mutationOptions) =>
      projectRepositoryQueue(store, "projectRepositorySetUserDefaultDomain", () =>
        projectRepositorySetUserDefaultDomain(store, owner, domain, mutationOptions),
      ),
    history: (key, limit) =>
      projectRepositoryQueue(store, "projectRepositoryHistory", async () => {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          return createResultError("projectRepositoryHistory", "limit must be a positive integer")
        }
        const safeR = await projectRepositoryProjectsSafe(store)
        if (!safeR.success) return safeR
        const cleanR = await projectRepositoryRequireClean(store, "projectRepositoryHistory")
        if (!cleanR.success) return cleanR
        let path = "projects"
        if (key !== undefined) {
          const pathR = projectRepositoryPath(key)
          if (!pathR.success) return pathR
          path = pathR.data
        }
        return gitStoreHistory(store.git, path, limit)
      }),
    ownerHistory: (owner, limit) =>
      projectRepositoryQueue(store, "projectRepositoryOwnerHistory", async () => {
        const ownerPathR = projectRepositoryOwnerPath(owner)
        if (!ownerPathR.success) return ownerPathR
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          return createResultError("projectRepositoryOwnerHistory", "limit must be a positive integer")
        }
        const safeR = await projectRepositoryProjectsSafe(store)
        if (!safeR.success) return safeR
        const cleanR = await projectRepositoryRequireClean(store, "projectRepositoryOwnerHistory")
        if (!cleanR.success) return cleanR
        const historyR = await gitStoreHistory(store.git, ownerPathR.data, limit)
        if (!historyR.success) return historyR
        return createResult(projectRepositoryHistoryDeduplicate(historyR.data, limit))
      }),
    readiness: () =>
      projectRepositoryQueue(store, "projectRepositoryReadiness", () => projectRepositoryReadiness(store)),
    recover: () => projectRepositoryQueue(store, "projectRepositoryRecover", () => projectRepositoryRecover(store)),
  }

  return createResult(repository)
}
