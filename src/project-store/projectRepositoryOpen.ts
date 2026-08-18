import { constants, type Dirent } from "node:fs"
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import * as a from "valibot"
import { type GitStore, gitStoreHistory, gitStoreList, gitStoreOpen, gitStoreRead, gitStoreRun } from "#git-store"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectCollisions } from "../project/projectCollisions.js"
import type { ProjectKey } from "../project/projectKey.js"
import { projectKeyEqual } from "../project/projectKeyEqual.js"
import { projectMutationExpectedRevision } from "../project/projectMutationExpectedRevision.js"
import { projectRevisionValidate } from "../project/projectRevisionValidate.js"
import { projectSchema } from "../project/projectSchema.js"
import { projectValidate } from "../project/projectValidate.js"
import type { ProjectRepository } from "./ProjectRepository.js"
import type { ProjectRepositoryEntry } from "./ProjectRepositoryEntry.js"
import type { ProjectRepositoryMutation } from "./ProjectRepositoryMutation.js"
import type { ProjectRepositoryMutationOptions } from "./ProjectRepositoryMutationOptions.js"
import { projectRepositoryOptionsSchema } from "./ProjectRepositoryOptions.js"
import type { ProjectRepositoryReadiness } from "./ProjectRepositoryReadiness.js"
import type { ProjectRepositorySnapshot } from "./ProjectRepositorySnapshot.js"
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
    return createResultError(op, "worktree is dirty; recover from HEAD before reading or mutating projects")
  }
  const divergenceR = await projectRepositoryTrackedDivergence(store, op)
  if (!divergenceR.success) return divergenceR
  return createResult(undefined)
}

function projectRepositoryMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function projectRepositoryProjectsDirectorySafe(
  directory: string,
  relativeDirectory: string,
): PromiseResult<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    return createResultError("projectRepositoryProjectsSafe", errorMessage(error), relativeDirectory)
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relativePath = `${relativeDirectory}/${entry.name}`
    let pathStat: Awaited<ReturnType<typeof lstat>>
    try {
      pathStat = await lstat(path)
    } catch (error) {
      return createResultError("projectRepositoryProjectsSafe", errorMessage(error), relativePath)
    }

    if (entry.name === ".git" || pathStat.isSymbolicLink()) {
      return createResultError(
        "projectRepositoryProjectsSafe",
        "symbolic links and reserved .git paths are not allowed beneath projects",
        relativePath,
      )
    }

    if (pathStat.isDirectory()) {
      const safeR = await projectRepositoryProjectsDirectorySafe(path, relativePath)
      if (!safeR.success) return safeR
    }
  }

  return createResult(undefined)
}

async function projectRepositoryProjectsSafe(store: GitProjectRepository): PromiseResult<void> {
  let currentDir: string
  try {
    currentDir = await realpath(store.git.dir)
  } catch (error) {
    return createResultError("projectRepositoryProjectsSafe", errorMessage(error), store.git.dir)
  }
  if (currentDir !== store.queueKey) {
    return createResultError("projectRepositoryProjectsSafe", "worktree path is not the canonical real worktree")
  }

  const root = join(store.git.dir, "projects")
  let rootStat: Awaited<ReturnType<typeof lstat>>
  try {
    rootStat = await lstat(root)
  } catch (error) {
    if (projectRepositoryMissing(error)) return createResult(undefined)
    return createResultError("projectRepositoryProjectsSafe", errorMessage(error), "projects")
  }

  if (rootStat.isSymbolicLink()) {
    return createResultError(
      "projectRepositoryProjectsSafe",
      "symbolic links and reserved .git paths are not allowed beneath projects",
      "projects",
    )
  }
  if (!rootStat.isDirectory()) return createResultError("projectRepositoryProjectsSafe", "projects is not a directory")
  return projectRepositoryProjectsDirectorySafe(root, "projects")
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
  project: Project,
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
    await fileHandle.writeFile(`${JSON.stringify(project, null, 2)}\n`, "utf8")
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

async function projectRepositoryReadSnapshot(store: GitProjectRepository): PromiseResult<ProjectRepositorySnapshot> {
  const op = "projectRepositoryRead"
  const safeR = await projectRepositoryProjectsSafe(store)
  if (!safeR.success) return safeR

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

    const projectR = await gitStoreRead(store.git, relPath, projectSchema)
    if (!projectR.success) {
      return createResultError(op, `${relPath}: ${projectR.errorMessage}`, relPath)
    }

    const validatedR = projectValidate(projectR.data)
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

  const revisionR = await projectRepositoryRevision(store)
  if (!revisionR.success) return revisionR
  return createResult({ projects, revision: revisionR.data })
}

function projectRepositoryContentsEqual(left: Project, right: Project): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function projectRepositoryActor(options: ProjectRepositoryMutationOptions, op: string): Result<string> {
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

function projectRepositoryExpectedRevision(options: unknown, currentRevision: unknown, op: string): Result<void> {
  const expectedR = projectMutationExpectedRevision(options, currentRevision, op)
  if (!expectedR.success) return expectedR
  if (expectedR.data !== currentRevision) {
    return createResultError(op, `revision mismatch: expected ${expectedR.data}, current ${currentRevision}`)
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

  const projectR = projectValidate(input)
  if (!projectR.success) return createResultError(op, projectR.errorMessage)
  const project = projectR.data
  const existing = snapshotR.data.projects.find((item) => projectKeyEqual(item, project))
  if (existing) {
    if (projectRepositoryContentsEqual(existing, project))
      return projectRepositoryNoop("create", project, snapshotR.data.revision)
    return createResultError(op, "project already exists")
  }

  const collisionsR = projectCollisions([...snapshotR.data.projects, project])
  if (!collisionsR.success) return createResultError(op, collisionsR.errorMessage)
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

  const projectR = projectValidate(input)
  if (!projectR.success) return createResultError(op, projectR.errorMessage)
  const project = projectR.data
  if (!projectKeyEqual(project, key)) return createResultError(op, "project owner and name are immutable")

  const existing = snapshotR.data.projects.find((item) => projectKeyEqual(item, key))
  if (!existing) return createResultError(op, "project not found")
  if (projectRepositoryContentsEqual(existing, project))
    return projectRepositoryNoop("edit", project, snapshotR.data.revision)

  const replacement = snapshotR.data.projects.map((item) => (projectKeyEqual(item, key) ? project : item))
  const collisionsR = projectCollisions(replacement)
  if (!collisionsR.success) return createResultError(op, collisionsR.errorMessage)
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
  if (!existing) return createResultError(op, "project not found")
  return projectRepositoryCommit(store, "delete", key, actorR.data, pathR.data, undefined, snapshotR.data.revision)
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
        if (!project) return createResultError("projectRepositoryGet", "project not found")
        const entry: ProjectRepositoryEntry = { project, revision: snapshotR.data.revision }
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
    readiness: () =>
      projectRepositoryQueue(store, "projectRepositoryReadiness", () => projectRepositoryReadiness(store)),
    recover: () => projectRepositoryQueue(store, "projectRepositoryRecover", () => projectRepositoryRecover(store)),
  }

  return createResult(repository)
}
