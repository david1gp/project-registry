import { isAbsolute, relative, resolve } from "node:path"
import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { DevCommandOverride } from "../dev/DevCommandOverride.js"
import type { DevProjectFilesystem } from "../dev/DevProjectFilesystem.js"
import { devCommandResolve } from "../dev/devCommandResolve.js"
import { devProjectDirectoryResolve } from "../dev/devProjectDirectoryResolve.js"
import { projectServiceEnvFileValidate } from "../project/projectServiceEnvFileValidate.js"
import type { ManagedServiceEntry } from "./ManagedServiceEntry.js"

export const managedServiceHost = "127.0.0.1"

export type ManagedServiceCommand = DevCommandOverride & {
  workingDirectory: string
  envFile?: string
}

function underDirectory(directory: string, candidate: string): boolean {
  const relationship = relative(directory, candidate)
  return relationship !== "" && !relationship.startsWith("..") && !isAbsolute(relationship)
}

/**
 * Resolve the argv, working directory, and env file for one managed service.
 * Same derivation as `dev up` (row command with {port}/{host}, else the
 * package.json dev script, else `bun run dev`), but on the row's registered
 * port and loopback. Project-relative executables and the env file must stay
 * inside the real project directory; symlinks out of it are refused because
 * systemd (PID 1, root) reads EnvironmentFile before dropping privileges.
 */
export async function managedServiceCommandResolve(options: {
  entry: ManagedServiceEntry
  projectsRoot: string
  filesystem: DevProjectFilesystem
}): PromiseResult<ManagedServiceCommand> {
  const op = "managedServiceCommandResolve"
  const { entry, projectsRoot, filesystem } = options
  const directoryR = await devProjectDirectoryResolve({ projectsRoot, project: entry.project, filesystem })
  if (!directoryR.success) return { ...directoryR, op }
  const directory = directoryR.data
  const commandR = await devCommandResolve({
    directory,
    projectsRoot,
    filesystem,
    ...(entry.managed.command === undefined ? {} : { rowCommand: entry.managed.command }),
    port: entry.port,
    host: managedServiceHost,
    project: entry.project,
  })
  if (!commandR.success) return { ...commandR, op }
  let command = commandR.data.command
  if (command.includes("/") && !isAbsolute(command)) {
    const binary = resolve(directory, command)
    if (!underDirectory(directory, binary)) {
      return createResultErrorCode(op, "service command escapes its project directory", "request.invalid")
    }
    command = binary
  }
  if (isAbsolute(command) && command.startsWith(`${directory}/`)) {
    let real: string
    try {
      real = await filesystem.realpath(command)
    } catch {
      return createResultErrorCode(op, `service command ${command} is missing`, "request.invalid")
    }
    if (!underDirectory(resolve(projectsRoot), real)) {
      return createResultErrorCode(op, "service command escapes its projects root", "request.invalid")
    }
  }
  const resolved: ManagedServiceCommand = { command, args: commandR.data.args, workingDirectory: directory }
  if (entry.managed.envFile === undefined) return createResult(resolved)
  const envFileR = projectServiceEnvFileValidate(entry.managed.envFile)
  if (!envFileR.success) return createResultErrorCode(op, envFileR.errorMessage, "request.invalid")
  const envFile = resolve(directory, envFileR.data)
  try {
    const real = await filesystem.realpath(envFile)
    if (real !== envFile || !underDirectory(directory, real)) {
      return createResultErrorCode(op, "service env file must not be a symlink", "request.invalid")
    }
  } catch {
    // Missing is allowed: the unit uses `EnvironmentFile=-…`.
  }
  return createResult({ ...resolved, envFile })
}
