#!/usr/bin/env bun

import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createResult, createResultError, type PromiseResult, type Result } from "@adaptive-ds/result"
import { caddyConfigGenerate } from "../../src/caddy/caddyConfigGenerate.js"
import { caddyConfigOptionsFromEnv } from "../../src/caddy/caddyConfigOptionsFromEnv.js"
import { caddyConfigSerialize } from "../../src/caddy/caddyConfigSerialize.js"
import type { Project } from "../../src/project/Project.js"
import { projectCollisions } from "../../src/project/projectCollisions.js"
import { projectKeyEqual } from "../../src/project/projectKeyEqual.js"
import { projectRevisionValidate } from "../../src/project/projectRevisionValidate.js"
import { projectValidate } from "../../src/project/projectValidate.js"
import { projectRepositoryPath } from "../../src/project-store/projectRepositoryPath.js"

type CandidateOptions = {
  output?: string
  repository: string
}

type CandidateArguments = { help: true } | { help: false; options: CandidateOptions }

type CandidateGitCommand = {
  exitCode: number
  stderr: string
  stdout: string
}

function candidateArgumentValue(args: readonly string[], index: number, option: string): Result<string> {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    return createResultError("caddyCandidateArgumentsParse", `${option} needs a value`)
  }
  return createResult(value)
}

function candidateArgumentsParse(args: readonly string[]): Result<CandidateArguments> {
  let repository: string | undefined
  let output: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--help" || argument === "-h") return createResult({ help: true })

    const valueOption = ["--repository", "--output"].find((option) => argument === option)
    if (valueOption !== undefined) {
      const valueR = candidateArgumentValue(args, index, valueOption)
      if (!valueR.success) return valueR
      index += 1
      if (valueOption === "--repository") repository = valueR.data
      else output = valueR.data
      continue
    }

    return createResultError("caddyCandidateArgumentsParse", `unknown argument: ${argument}`)
  }

  if (repository === undefined || repository.trim() === "") {
    return createResultError("caddyCandidateArgumentsParse", "--repository is required")
  }

  return createResult({
    help: false,
    options: {
      ...(output === undefined ? {} : { output }),
      repository,
    },
  })
}

async function candidateGitCommand(
  repository: string,
  args: readonly string[],
  environment: Record<string, string | undefined>,
): PromiseResult<CandidateGitCommand> {
  const op = "caddyCandidateRepositoryRead"
  try {
    const gitEnvironment: Record<string, string> = {}
    for (const [key, value] of Object.entries(environment)) {
      if (value !== undefined) gitEnvironment[key] = value
    }
    gitEnvironment.GIT_OPTIONAL_LOCKS = "0"

    const process = Bun.spawn(["git", ...args], {
      cwd: repository,
      env: gitEnvironment,
      stderr: "pipe",
      stdout: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    return createResult({ exitCode, stderr, stdout })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createResultError(op, `unable to inspect Git repository: ${message}`, repository)
  }
}

function candidateRepositoryError(repository: string, message: string): Result<never> {
  return createResultError("caddyCandidateRepositoryRead", message, repository)
}

async function candidateGitRequired(
  repository: string,
  args: readonly string[],
  environment: Record<string, string | undefined>,
): PromiseResult<string> {
  const commandR = await candidateGitCommand(repository, args, environment)
  if (!commandR.success) return commandR
  if (commandR.data.exitCode === 0) return createResult(commandR.data.stdout)

  const detail = (commandR.data.stderr || commandR.data.stdout).trim() || `git exited ${commandR.data.exitCode}`
  return candidateRepositoryError(repository, `invalid Git repository: git ${args.join(" ")}: ${detail}`)
}

async function candidateRepositoryValidate(
  repository: string,
  environment: Record<string, string | undefined>,
): PromiseResult<string> {
  let canonicalRepository: string
  try {
    const repositoryStat = await lstat(repository)
    if (!repositoryStat.isDirectory()) return candidateRepositoryError(repository, "repository path is not a directory")
    canonicalRepository = await realpath(repository)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return candidateRepositoryError(repository, `repository is absent or unreadable: ${message}`)
  }

  const insideR = await candidateGitRequired(canonicalRepository, ["rev-parse", "--is-inside-work-tree"], environment)
  if (!insideR.success) return insideR
  if (insideR.data.trim() !== "true") return candidateRepositoryError(repository, "path is not a Git worktree")

  const topLevelR = await candidateGitRequired(canonicalRepository, ["rev-parse", "--show-toplevel"], environment)
  if (!topLevelR.success) return topLevelR
  let canonicalTopLevel: string
  try {
    canonicalTopLevel = await realpath(topLevelR.data.trim())
  } catch {
    return candidateRepositoryError(repository, "unable to resolve the Git worktree root")
  }
  if (canonicalTopLevel !== canonicalRepository) {
    return candidateRepositoryError(repository, "path is not the root of its Git worktree")
  }

  const branchR = await candidateGitRequired(canonicalRepository, ["branch", "--show-current"], environment)
  if (!branchR.success) return branchR
  if (branchR.data.trim() !== "main") {
    const branch = branchR.data.trim() || "detached HEAD"
    return candidateRepositoryError(repository, `current branch ${branch} does not match configured branch main`)
  }

  const revisionR = await candidateGitRequired(canonicalRepository, ["rev-parse", "--verify", "HEAD"], environment)
  if (!revisionR.success) return revisionR
  const validatedRevisionR = projectRevisionValidate(revisionR.data.trim(), "caddyCandidateRepositoryRead")
  if (!validatedRevisionR.success) return candidateRepositoryError(repository, validatedRevisionR.errorMessage)

  const statusR = await candidateGitRequired(
    canonicalRepository,
    ["status", "--porcelain", "--untracked-files=all"],
    environment,
  )
  if (!statusR.success) return statusR
  if (statusR.data.trim() !== "") return candidateRepositoryError(repository, "Git worktree is dirty")

  for (const args of [
    ["diff-files", "--quiet", "--"],
    ["diff-index", "--quiet", "--cached", "HEAD", "--"],
  ]) {
    const diffR = await candidateGitCommand(canonicalRepository, args, environment)
    if (!diffR.success) return diffR
    if (diffR.data.exitCode === 1)
      return candidateRepositoryError(repository, "Git index or worktree differs from HEAD")
    if (diffR.data.exitCode !== 0) {
      const detail = (diffR.data.stderr || diffR.data.stdout).trim() || `git exited ${diffR.data.exitCode}`
      return candidateRepositoryError(repository, `unable to validate Git repository: ${detail}`)
    }
  }

  return createResult(canonicalRepository)
}

async function candidateProjectPathsRead(directory: string, relativeDirectory: string): PromiseResult<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createResultError("caddyCandidateRepositoryRead", message, relativeDirectory)
  }

  const paths: string[] = []
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    const path = join(directory, entry.name)
    let pathStat: Awaited<ReturnType<typeof lstat>>
    try {
      pathStat = await lstat(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return createResultError("caddyCandidateRepositoryRead", message, relativePath)
    }

    if (entry.name === ".git" || pathStat.isSymbolicLink()) {
      return createResultError(
        "caddyCandidateRepositoryRead",
        "symbolic links and reserved .git paths are not allowed beneath projects",
        relativePath,
      )
    }
    if (pathStat.isDirectory()) {
      const nestedR = await candidateProjectPathsRead(path, relativePath)
      if (!nestedR.success) return nestedR
      paths.push(...nestedR.data)
    } else if (pathStat.isFile() && entry.name.endsWith(".json")) {
      paths.push(relativePath)
    }
  }
  return createResult(paths.sort())
}

async function candidateProjectPaths(repository: string): PromiseResult<string[]> {
  const projectsDirectory = join(repository, "projects")
  let projectsStat: Awaited<ReturnType<typeof lstat>>
  try {
    projectsStat = await lstat(projectsDirectory)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return createResult([])
    const message = error instanceof Error ? error.message : String(error)
    return createResultError("caddyCandidateRepositoryRead", message, "projects")
  }
  if (projectsStat.isSymbolicLink() || !projectsStat.isDirectory()) {
    return createResultError("caddyCandidateRepositoryRead", "projects is not a directory", "projects")
  }
  return candidateProjectPathsRead(projectsDirectory, "projects")
}

async function candidateProjectRead(repository: string, relativePath: string): PromiseResult<Project> {
  let raw: string
  try {
    raw = await readFile(join(repository, relativePath), "utf8")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createResultError("caddyCandidateRepositoryRead", `unable to read project file: ${message}`, relativePath)
  }

  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createResultError("caddyCandidateRepositoryRead", `invalid JSON: ${message}`, relativePath)
  }

  const projectR = projectValidate(input)
  if (!projectR.success) return createResultError("caddyCandidateRepositoryRead", projectR.errorMessage, relativePath)
  return projectR
}

async function candidateRepositoryProjectsRead(
  repository: string,
  environment: Record<string, string | undefined>,
): PromiseResult<Project[]> {
  const pathsR = await candidateProjectPaths(repository)
  if (!pathsR.success) return pathsR

  const trackedR = await candidateGitRequired(repository, ["ls-files", "--cached", "--full-name", "-z"], environment)
  if (!trackedR.success) return trackedR
  const tracked = new Set(trackedR.data.split("\0").filter((path) => path !== ""))
  const projects: Project[] = []

  for (const relativePath of pathsR.data) {
    if (!tracked.has(relativePath)) {
      return createResultError("caddyCandidateRepositoryRead", "project file is not tracked by Git", relativePath)
    }

    const match = /^projects\/([^/]+)\/([^/]+)\.json$/.exec(relativePath)
    const owner = match?.[1]
    const name = match?.[2]
    if (owner === undefined || name === undefined) {
      return createResultError("caddyCandidateRepositoryRead", "invalid project path", relativePath)
    }
    const pathR = projectRepositoryPath({ owner, name })
    if (!pathR.success || pathR.data !== relativePath) {
      return createResultError("caddyCandidateRepositoryRead", "invalid project path", relativePath)
    }

    const projectR = await candidateProjectRead(repository, relativePath)
    if (!projectR.success) return projectR
    if (!projectKeyEqual(projectR.data, { owner, name })) {
      return createResultError(
        "caddyCandidateRepositoryRead",
        "project owner/name does not match its path",
        relativePath,
      )
    }
    projects.push(projectR.data)
  }

  const collisionsR = projectCollisions(projects)
  if (!collisionsR.success) return createResultError("caddyCandidateRepositoryRead", collisionsR.errorMessage)
  return createResult(projects)
}

export async function caddyCandidateGenerate(
  repository: string,
  environment: Record<string, string | undefined>,
): PromiseResult<string> {
  const optionsR = caddyConfigOptionsFromEnv(environment)
  if (!optionsR.success) return optionsR

  const repositoryR = await candidateRepositoryValidate(repository, environment)
  if (!repositoryR.success) return repositoryR

  const projectsR = await candidateRepositoryProjectsRead(repositoryR.data, environment)
  if (!projectsR.success) return projectsR

  const configR = caddyConfigGenerate(projectsR.data, optionsR.data)
  if (!configR.success) return configR
  return caddyConfigSerialize(configR.data)
}

async function caddyCandidateOutputWrite(output: string, path: string): PromiseResult<void> {
  try {
    await writeFile(path, `${output}\n`, { encoding: "utf8", flag: "w" })
    return createResult(undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createResultError("caddyCandidateOutputWrite", message, path)
  }
}

function caddyCandidateUsage(): string {
  return `Usage:
  bun run ops/migration/caddy-candidate-generate.ts --repository PATH [--output PATH]

Options:
  --repository PATH  Migrated Project Registry Git worktree
  --output PATH      Write candidate JSON to PATH instead of stdout; use - for stdout
  --help             Show this help

OIDC values are read from the process environment using the existing
PROJECT_REGISTRY_OIDC_* names and CADDY_PROJECTS_OIDC_* Leo-compatible aliases.`
}

if (import.meta.main) {
  const argumentsR = candidateArgumentsParse(process.argv.slice(2))
  if (!argumentsR.success) {
    console.error(`candidate generation failed: ${argumentsR.errorMessage}`)
    process.exitCode = 1
  } else if (argumentsR.data.help) {
    console.log(caddyCandidateUsage())
  } else {
    const resultR = await caddyCandidateGenerate(argumentsR.data.options.repository, Bun.env)
    if (!resultR.success) {
      console.error(`candidate generation failed: ${resultR.errorMessage}`)
      process.exitCode = 1
    } else if (argumentsR.data.options.output !== undefined && argumentsR.data.options.output !== "-") {
      const outputR = await caddyCandidateOutputWrite(resultR.data, resolve(argumentsR.data.options.output))
      if (!outputR.success) {
        console.error(`candidate generation failed: ${outputR.errorMessage}`)
        process.exitCode = 1
      }
    } else {
      console.log(resultR.data)
    }
  }
}
