import { join, relative, resolve } from "node:path"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { Actor } from "../access/Actor.js"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import { projectAccessCreate } from "../access/projectAccessCreate.js"
import { projectAccessLogSourceFileCreate } from "../access-log/projectAccessLogSourceFileCreate.js"
import { projectRegistryApiHandlerCreate } from "../api/projectRegistryApiHandlerCreate.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import { sessionActorResolve } from "../session/sessionActorResolve.js"
import { sessionRequestResolve } from "../session/sessionRequestResolve.js"
import type { ProjectRegistryDaemon } from "./ProjectRegistryDaemon.js"
import type { ProjectRegistryDaemonBrowserAuth } from "./ProjectRegistryDaemonBrowserAuth.js"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"
import type { ProjectRegistryDaemonHealth } from "./ProjectRegistryDaemonHealth.js"
import type { ProjectRegistryDaemonMappedUser } from "./ProjectRegistryDaemonMappedUser.js"
import type { ProjectRegistryDaemonOptions } from "./ProjectRegistryDaemonOptions.js"
import type { ProjectRegistryDaemonReadiness } from "./ProjectRegistryDaemonReadiness.js"
import type { ProjectRegistryDaemonRequestContext } from "./ProjectRegistryDaemonRequestContext.js"
import type { ProjectRegistryDaemonServer } from "./ProjectRegistryDaemonServer.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import type { ProjectRegistryDaemonSignals } from "./ProjectRegistryDaemonSignals.js"
import type { ProjectRegistryDaemonSocketRefresh } from "./ProjectRegistryDaemonSocketRefresh.js"
import type { ProjectRegistryDaemonState } from "./ProjectRegistryDaemonState.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"
import { projectRegistryDaemonFilesystemDefault } from "./projectRegistryDaemonFilesystemDefault.js"
import { projectRegistryDaemonPosixDefault } from "./projectRegistryDaemonPosixDefault.js"
import { projectRegistryDaemonServerDefault } from "./projectRegistryDaemonServerDefault.js"
import { projectRegistryDaemonSignalsDefault } from "./projectRegistryDaemonSignalsDefault.js"

const socketMode = 0o600
const directoryMode = 0o755
const maximumPosixId = 0xffffffff
const maximumUsernameLength = 255

type SocketRecord = {
  path: string
  mapping: ProjectRegistryDaemonMappedUser
  server: ProjectRegistryDaemonServer
  forceCleanup?: boolean
}

type RuntimeTimer = {
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usernameIsSafe(username: string): boolean {
  return username.length <= maximumUsernameLength && /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(username)
}

function mappedUserIsValid(user: unknown): user is ProjectRegistryDaemonMappedUser {
  try {
    if (typeof user !== "object" || user === null || Array.isArray(user)) return false
    const value = user as Record<string, unknown>
    return (
      typeof value.username === "string" &&
      usernameIsSafe(value.username) &&
      Number.isSafeInteger(value.uid) &&
      (value.uid as number) >= 0 &&
      (value.uid as number) <= maximumPosixId &&
      Number.isSafeInteger(value.gid) &&
      (value.gid as number) >= 0 &&
      (value.gid as number) <= maximumPosixId
    )
  } catch {
    return false
  }
}

function mappedUserValidate(value: unknown, op: string): Result<ProjectRegistryDaemonMappedUser> {
  try {
    if (!mappedUserIsValid(value)) return createResultError(op, "mapped user data is invalid")
    const user = value as ProjectRegistryDaemonMappedUser
    return createResult({ username: user.username, uid: user.uid, gid: user.gid })
  } catch {
    return createResultError(op, "mapped user data is invalid")
  }
}

function mappedUsersValidate(value: unknown, op: string): Result<readonly ProjectRegistryDaemonMappedUser[]> {
  try {
    if (!Array.isArray(value)) return createResultError(op, "mapped user resolver returned invalid user data")
    const users: ProjectRegistryDaemonMappedUser[] = []
    const usernames = new Set<string>()
    for (let index = 0; index < value.length; index += 1) {
      const userR = mappedUserValidate(value[index], op)
      if (!userR.success) return userR
      if (usernames.has(userR.data.username)) {
        return createResultError(op, `mapped user ${userR.data.username} is duplicated`)
      }
      usernames.add(userR.data.username)
      users.push(userR.data)
    }
    return createResult(users)
  } catch {
    return createResultError(op, "mapped user resolver returned invalid user data")
  }
}

function resultErrorMessage(value: unknown): string | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined
    const result = value as Record<string, unknown>
    if (result.success !== false || typeof result.op !== "string" || typeof result.errorMessage !== "string") {
      return undefined
    }
    return result.errorMessage
  } catch {
    return undefined
  }
}

function mappedUserResultValidate(value: unknown): Result<ProjectRegistryDaemonMappedUser> {
  const op = "projectRegistryDaemonUserResolve"
  try {
    if (typeof value !== "object" || value === null)
      return createResultError(op, "user resolver returned an invalid result")
    const result = value as Record<string, unknown>
    if (result.success === false) {
      const message = resultErrorMessage(value)
      return message === undefined
        ? createResultError(op, "user resolver returned an invalid result")
        : createResultError(op, message)
    }
    if (result.success !== true || !("data" in result)) {
      return createResultError(op, "user resolver returned an invalid result")
    }
    return mappedUserValidate(result.data, op)
  } catch {
    return createResultError(op, "user resolver returned an invalid result")
  }
}

function mappedUsersResultValidate(value: unknown): Result<readonly ProjectRegistryDaemonMappedUser[]> {
  const op = "projectRegistryDaemonMappedUsers"
  try {
    if (typeof value !== "object" || value === null)
      return createResultError(op, "mapped user resolver returned an invalid result")
    const result = value as Record<string, unknown>
    if (result.success === false) {
      const message = resultErrorMessage(value)
      return message === undefined
        ? createResultError(op, "mapped user resolver returned an invalid result")
        : createResultError(op, message)
    }
    if (result.success !== true || !("data" in result)) {
      return createResultError(op, "mapped user resolver returned an invalid result")
    }
    return mappedUsersValidate(result.data, op)
  } catch {
    return createResultError(op, "mapped user resolver returned an invalid result")
  }
}

function socketPath(directory: string, username: string): Result<string> {
  const op = "projectRegistryDaemonSocketPath"
  if (!usernameIsSafe(username)) return createResultError(op, "mapped user name is not safe", username)
  const path = join(directory, `${username}.sock`)
  if (resolve(path) !== path || relative(directory, path).startsWith("..")) {
    return createResultError(op, "socket path escapes its directory", path)
  }
  return createResult(path)
}

function statIsSocketOwned(stat: ProjectRegistryDaemonFileStat, mapping: ProjectRegistryDaemonMappedUser): boolean {
  return stat.type === "socket" && stat.uid === mapping.uid && stat.gid === mapping.gid
}

function statModeIsPrivate(stat: ProjectRegistryDaemonFileStat): boolean {
  return (stat.mode & 0o7777) === socketMode
}

function defaultTimer(): RuntimeTimer {
  return {
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as number),
  }
}

function serverStop(server: ProjectRegistryDaemonServer): Promise<void> {
  return Promise.resolve().then(() => server.stop({ closeActiveConnections: true }))
}

export function projectRegistryDaemonCreate(options: ProjectRegistryDaemonOptions): Result<ProjectRegistryDaemon> {
  const op = "projectRegistryDaemonCreate"
  if (typeof options !== "object" || options === null) return createResultError(op, "daemon options are required")

  let configInput: unknown
  let repositoryOption: ProjectRepository | undefined
  let caddyApplicationOption: ProjectRegistryDaemonOptions["caddyApplication"]
  let accessLogSourceOption: ProjectRegistryDaemonOptions["projectAccessLogSource"]
  let browserAuthOption: ProjectRegistryDaemonOptions["browserAuth"]
  let socketAccessResolveOption: ProjectRegistryDaemonOptions["socketAccessResolve"]
  let mappedUsersResolveOption: ProjectRegistryDaemonOptions["mappedUsersResolve"]
  let requestHandlerOption: ProjectRegistryDaemonOptions["requestHandler"]
  let filesystemOption: ProjectRegistryDaemonOptions["filesystem"]
  let posixOption: ProjectRegistryDaemonOptions["posix"]
  let serverFactoryOption: ProjectRegistryDaemonOptions["serverFactory"]
  let signalsOption: ProjectRegistryDaemonOptions["signals"]
  let timerOption: ProjectRegistryDaemonOptions["timer"]
  let requireRootOption: ProjectRegistryDaemonOptions["requireRoot"]
  try {
    configInput = options.config
    repositoryOption = options.repository
    caddyApplicationOption = options.caddyApplication
    accessLogSourceOption = options.projectAccessLogSource
    browserAuthOption = options.browserAuth
    socketAccessResolveOption = options.socketAccessResolve
    mappedUsersResolveOption = options.mappedUsersResolve
    requestHandlerOption = options.requestHandler
    filesystemOption = options.filesystem
    posixOption = options.posix
    serverFactoryOption = options.serverFactory
    signalsOption = options.signals
    timerOption = options.timer
    requireRootOption = options.requireRoot
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : "invalid daemon options")
  }
  if (requireRootOption !== undefined && typeof requireRootOption !== "boolean") {
    return createResultError(op, "requireRoot must be a boolean")
  }

  const configR = projectRegistryDaemonConfigValidate(configInput)
  if (!configR.success) return configR
  if (repositoryOption === undefined) return createResultError(op, "project repository is required")
  if (caddyApplicationOption === undefined) return createResultError(op, "Caddy application is required")

  const config: ProjectRegistryDaemonConfig = configR.data
  const repository = repositoryOption
  const caddyApplication = caddyApplicationOption
  const filesystem = filesystemOption ?? projectRegistryDaemonFilesystemDefault()
  const posix = posixOption ?? projectRegistryDaemonPosixDefault()
  const serverFactory = serverFactoryOption ?? projectRegistryDaemonServerDefault()
  const signals: ProjectRegistryDaemonSignals = signalsOption ?? projectRegistryDaemonSignalsDefault()
  const timer: RuntimeTimer = timerOption ?? defaultTimer()
  const mappedUsersResolve = mappedUsersResolveOption
  const socketRecords = new Map<string, SocketRecord>()
  const cleanupRecords = new Map<string, SocketRecord>()
  const signalCleanups: Array<() => void> = []
  let webServer: ProjectRegistryDaemonServer | undefined
  let userRefreshHandle: unknown
  let socketRefreshPromise: PromiseResult<ProjectRegistryDaemonSocketRefresh> | undefined
  let startPromise: PromiseResult<void> | undefined
  let shutdownPromise: PromiseResult<void> | undefined
  let resourceCleanupPromise: Promise<string[]> | undefined
  let caddyStopPromise: Promise<string[]> | undefined
  let gitTail: Promise<void> = Promise.resolve()
  let state: ProjectRegistryDaemonState = "created"
  let socketStateReady = false
  let caddyStarted = false
  let caddyStartAttempted = false
  let signalsInstalled = false
  let terminationSettled = false
  let shutdownSettled = false
  let resolveTermination!: (result: Result<void>) => void
  const terminationPromise: PromiseResult<void> = new Promise((resolve) => {
    resolveTermination = resolve
  })
  const stoppedServers = new WeakSet<object>()
  const lateServerHandles = new Set<ProjectRegistryDaemonServer>()

  function shutdownRetryRequired(): void {
    if (state !== "stopped" || !shutdownSettled) return
    shutdownPromise = undefined
    resourceCleanupPromise = undefined
    shutdownSettled = false
  }

  function healthLive(): ProjectRegistryDaemonHealth {
    return { live: state !== "failed" && state !== "stopping" && state !== "stopped", state }
  }

  function daemonStopping(): boolean {
    return state === "stopping" || state === "stopped"
  }

  function terminationSettle(result: Result<void>): void {
    if (terminationSettled) return
    terminationSettled = true
    resolveTermination(result)
  }

  function serverStopOnce(server: ProjectRegistryDaemonServer): Promise<void> {
    if (stoppedServers.has(server)) return Promise.resolve()
    return serverStop(server).then(() => {
      stoppedServers.add(server)
    })
  }

  async function serverCreate(
    serverOptions: Parameters<ProjectRegistryDaemonServerFactory>[0],
    lateCleanup?: () => Promise<void>,
  ): PromiseResult<ProjectRegistryDaemonServer> {
    let server: ProjectRegistryDaemonServer
    try {
      server = await serverFactory(serverOptions)
    } catch (error) {
      try {
        await lateCleanup?.()
      } catch {
        // Preserve the server factory failure.
      }
      return createResultError("projectRegistryDaemonServerCreate", errorMessage(error))
    }
    if (!daemonStopping()) return createResult(server)

    lateServerHandles.add(server)
    shutdownRetryRequired()
    try {
      await serverStopOnce(server)
      lateServerHandles.delete(server)
    } catch {
      // Cleanup continues even when a late server refuses to stop.
    }
    try {
      await lateCleanup?.()
    } catch {
      // The late server is no longer reachable by the daemon.
    }
    return createResultError("projectRegistryDaemonServerCreate", "daemon shutdown started")
  }

  async function rootCheck(): Promise<Result<true>> {
    if (requireRootOption === false) return createResult(true)
    try {
      const result = await posix.isRoot()
      return result === true ? createResult(true) : createResultError(op, "project-registryd must run as root")
    } catch {
      return createResultError(op, "root privilege check failed")
    }
  }

  async function safeLstat(path: string): Promise<ProjectRegistryDaemonFileStat | undefined> {
    try {
      return await filesystem.lstat(path)
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }

  async function filesystemChmodNoFollow(path: string, mode: number): Promise<void> {
    if (filesystem.chmodNoFollow !== undefined) {
      await filesystem.chmodNoFollow(path, mode)
      return
    }
    await filesystem.chmod(path, mode)
  }

  async function filesystemChownNoFollow(path: string, uid: number, gid: number): Promise<void> {
    if (filesystem.chownNoFollow !== undefined) {
      await filesystem.chownNoFollow(path, uid, gid)
      return
    }
    await filesystem.chown(path, uid, gid)
  }

  async function ensureSocketDirectory(): Promise<Result<string>> {
    const directory = resolve(config.socketDirectory)
    const segments = directory.split("/").filter((segment) => segment !== "")
    let current = "/"
    try {
      for (const segment of segments) {
        current = join(current, segment)
        let stat = await safeLstat(current)
        if (stat === undefined) {
          await filesystem.mkdir(current, directoryMode)
          stat = await safeLstat(current)
        }
        if (stat === undefined || stat.type === "symlink" || stat.type !== "directory") {
          return createResultError(
            "projectRegistryDaemonSocketDirectory",
            "socket directory contains an unsafe component",
            current,
          )
        }
        if (current !== directory && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
          return createResultError(
            "projectRegistryDaemonSocketDirectory",
            "socket directory ancestor must be root-owned and not group/world writable",
            current,
          )
        }
      }
      const canonical = await filesystem.realpath(directory)
      if (canonical !== directory) {
        return createResultError(
          "projectRegistryDaemonSocketDirectory",
          "socket directory must not contain symlinks",
          directory,
        )
      }
      const directoryStat = await safeLstat(directory)
      if (directoryStat === undefined || directoryStat.type !== "directory" || directoryStat.uid !== 0) {
        return createResultError(
          "projectRegistryDaemonSocketDirectory",
          "socket directory must be a root-owned directory",
          directory,
        )
      }
      if ((directoryStat.mode & 0o7777) !== directoryMode) {
        await filesystemChmodNoFollow(directory, directoryMode)
        const corrected = await safeLstat(directory)
        if (
          corrected === undefined ||
          corrected.type !== "directory" ||
          corrected.uid !== 0 ||
          (corrected.mode & 0o7777) !== directoryMode
        ) {
          return createResultError(
            "projectRegistryDaemonSocketDirectory",
            "socket directory mode could not be verified",
            directory,
          )
        }
      }
      return createResult(directory)
    } catch (error) {
      return createResultError("projectRegistryDaemonSocketDirectory", errorMessage(error), directory)
    }
  }

  async function removeOwnedSocket(record: SocketRecord, force = false): Promise<Result<void>> {
    const op = "projectRegistryDaemonSocketRemove"
    try {
      const stat = await safeLstat(record.path)
      if (stat === undefined) return createResult(undefined)
      if (stat.type === "symlink") return createResultError(op, "refusing to remove a symbolic link", record.path)
      if (!force && !statIsSocketOwned(stat, record.mapping)) {
        return createResultError(op, "refusing to remove a socket with unexpected ownership", record.path)
      }
      if (stat.type !== "socket") return createResultError(op, "refusing to remove a non-socket path", record.path)
      await filesystem.unlink(record.path)
      const after = await safeLstat(record.path)
      if (after !== undefined) return createResultError(op, "socket was not removed", record.path)
      return createResult(undefined)
    } catch (error) {
      return createResultError(op, errorMessage(error), record.path)
    }
  }

  function cleanupRecordTrack(record: SocketRecord): void {
    cleanupRecords.set(record.path, record)
    shutdownRetryRequired()
  }

  function cleanupRecordPending(path: string): boolean {
    return cleanupRecords.has(path)
  }

  async function stopAndRemove(record: SocketRecord, force = record.forceCleanup === true): Promise<Result<void>> {
    let message: string | undefined
    try {
      await serverStopOnce(record.server)
    } catch (error) {
      message = errorMessage(error)
    }
    const removeR = await removeOwnedSocket(record, force)
    if (!removeR.success) {
      cleanupRecordTrack(record)
      return removeR
    }
    if (message !== undefined) {
      cleanupRecordTrack(record)
      return createResultError("projectRegistryDaemonSocketStop", message, record.path)
    }
    cleanupRecords.delete(record.path)
    return createResult(undefined)
  }

  async function socketCreate(
    directory: string,
    mapping: ProjectRegistryDaemonMappedUser,
  ): Promise<Result<SocketRecord>> {
    const pathR = socketPath(directory, mapping.username)
    if (!pathR.success) return pathR
    const path = pathR.data
    const pendingRecord: SocketRecord = { path, mapping, server: { stop: () => undefined }, forceCleanup: true }
    try {
      const existing = await safeLstat(path)
      if (existing !== undefined) {
        if (existing.type === "symlink") return createResultError(op, "refusing a symbolic-link socket path", path)
        if (existing.type !== "socket") return createResultError(op, "refusing a non-socket socket path", path)
        if (!statIsSocketOwned(existing, mapping)) {
          return createResultError(op, "refusing a socket with unexpected ownership", path)
        }
        const staleRecord: SocketRecord = { path, mapping, server: { stop: () => undefined } }
        const removeR = await removeOwnedSocket(staleRecord)
        if (!removeR.success) {
          cleanupRecordTrack(staleRecord)
          return removeR
        }
      }

      const serverR = await serverCreate(
        {
          unix: path,
          fetch: (request) => handleRequest(request, { transport: "unix", username: mapping.username }),
        },
        async () => {
          try {
            const stat = await safeLstat(path)
            if (stat === undefined) return
            if (stat.type !== "socket") throw new Error(`socket cleanup found an unexpected ${stat.type} path`)
            await filesystem.unlink(path)
            const after = await safeLstat(path)
            if (after !== undefined) throw new Error("socket entry was not removed")
          } catch (error) {
            cleanupRecordTrack(pendingRecord)
            throw error
          }
        },
      )
      if (!serverR.success) return serverR
      const server = serverR.data
      const record: SocketRecord = { path, mapping, server }
      try {
        await filesystemChownNoFollow(path, mapping.uid, mapping.gid)
        await filesystemChmodNoFollow(path, socketMode)
        const stat = await safeLstat(path)
        if (
          stat === undefined ||
          stat.type !== "socket" ||
          stat.uid !== mapping.uid ||
          stat.gid !== mapping.gid ||
          !statModeIsPrivate(stat)
        ) {
          throw new Error("socket ownership or mode could not be verified")
        }
      } catch (error) {
        cleanupRecordTrack(record)
        const cleanupFailures: string[] = []
        try {
          await serverStopOnce(server)
        } catch (stopError) {
          cleanupFailures.push(`socket stop: ${errorMessage(stopError)}`)
        }
        try {
          const stat = await safeLstat(path)
          if (stat?.type === "socket") {
            try {
              await filesystem.unlink(path)
            } catch (unlinkError) {
              cleanupFailures.push(`socket unlink: ${errorMessage(unlinkError)}`)
            }
          } else if (stat !== undefined) {
            cleanupFailures.push(`socket cleanup found an unexpected ${stat.type} path`)
          }
        } catch (statError) {
          cleanupFailures.push(`socket cleanup stat: ${errorMessage(statError)}`)
        }
        return createResultError(op, [errorMessage(error), ...cleanupFailures].join("; "), path)
      }
      if (daemonStopping()) {
        const stopR = await stopAndRemove(record, true)
        if (!stopR.success) cleanupRecordTrack(record)
        return createResultError(op, "daemon shutdown started", path)
      }
      return createResult({ path, mapping, server })
    } catch (error) {
      return createResultError(op, errorMessage(error), path)
    }
  }

  async function posixUserResolve(username: string): PromiseResult<ProjectRegistryDaemonMappedUser> {
    try {
      const userR = mappedUserResultValidate(await posix.userResolve(username))
      if (!userR.success) return userR
      if (userR.data.username !== username) {
        return createResultError(
          "projectRegistryDaemonUserResolve",
          "user resolver returned a mismatched user",
          username,
        )
      }
      return userR
    } catch (error) {
      return createResultError("projectRegistryDaemonUserResolve", errorMessage(error), username)
    }
  }

  async function mappedUsersResolveDefault(): PromiseResult<{
    users: readonly ProjectRegistryDaemonMappedUser[]
    missingUsers: readonly string[]
  }> {
    const users: ProjectRegistryDaemonMappedUser[] = []
    const missingUsers: string[] = []
    for (const username of config.mappedUsers) {
      const userR = await posixUserResolve(username)
      if (!userR.success) {
        if (/does not exist|not found|enoent|missing/i.test(userR.errorMessage)) {
          missingUsers.push(username)
          continue
        }
        return createResultError("projectRegistryDaemonMappedUsers", userR.errorMessage, username)
      }
      users.push(userR.data)
    }
    return createResult({ users, missingUsers })
  }

  async function mappedUsersResolveCurrent(): Promise<
    Result<{ users: readonly ProjectRegistryDaemonMappedUser[]; missingUsers: readonly string[] }>
  > {
    if (mappedUsersResolve === undefined) {
      const resolved = await mappedUsersResolveDefault()
      if (!resolved.success) return resolved
      return createResult(resolved.data)
    }
    try {
      const resolvedValue = await mappedUsersResolve()
      const resolvedR = mappedUsersResultValidate(resolvedValue)
      if (!resolvedR.success) return resolvedR
      const configuredUsers = new Set(config.mappedUsers)
      const resolvedUsers = new Set(resolvedR.data.map((user) => user.username))
      if (
        configuredUsers.size !== resolvedUsers.size ||
        [...configuredUsers].some((username) => !resolvedUsers.has(username))
      ) {
        return createResultError(
          "projectRegistryDaemonMappedUsers",
          "mapped user resolver did not return the configured users exactly",
        )
      }
      return createResult({ users: resolvedR.data, missingUsers: [] })
    } catch (error) {
      return createResultError("projectRegistryDaemonMappedUsers", errorMessage(error))
    }
  }

  async function refreshSocketsInternal(): PromiseResult<ProjectRegistryDaemonSocketRefresh> {
    const usersR = await mappedUsersResolveCurrent()
    if (!usersR.success) {
      socketStateReady = false
      return usersR
    }

    const directoryR = await ensureSocketDirectory()
    if (!directoryR.success) {
      socketStateReady = false
      return directoryR
    }

    const users = usersR.data.users
    const missingUsers = [...usersR.data.missingUsers]
    const current = new Map<string, ProjectRegistryDaemonMappedUser>()
    const failures: string[] = []
    for (const user of users) {
      const userR = mappedUserValidate(user, "projectRegistryDaemonMappedUsers")
      if (!userR.success) {
        failures.push(`${user.username}: mapped user data is invalid`)
        continue
      }
      if (current.has(userR.data.username)) {
        failures.push(`${userR.data.username}: mapped user is duplicated`)
        continue
      }
      current.set(userR.data.username, userR.data)
    }

    for (const [path, record] of [...cleanupRecords.entries()]) {
      const cleanupR = await stopAndRemove(record)
      if (!cleanupR.success) failures.push(`${record.mapping.username}: ${cleanupR.errorMessage}`)
      else if (cleanupRecords.has(path)) failures.push(`${record.mapping.username}: socket cleanup remains pending`)
    }

    const created: string[] = []
    const removed: string[] = []
    for (const [username, record] of [...socketRecords.entries()]) {
      const mapping = current.get(username)
      if (mapping === undefined || mapping.uid !== record.mapping.uid || mapping.gid !== record.mapping.gid) {
        const stopR = await stopAndRemove(record)
        socketRecords.delete(username)
        if (!stopR.success) failures.push(`${username}: ${stopR.errorMessage}`)
        else removed.push(username)
      }
    }

    for (const mapping of current.values()) {
      const existing = socketRecords.get(mapping.username)
      if (existing !== undefined) {
        if (cleanupRecordPending(existing.path)) {
          failures.push(`${mapping.username}: socket cleanup remains pending`)
          continue
        }
        try {
          const stat = await safeLstat(existing.path)
          if (stat === undefined || stat.type !== "socket" || !statIsSocketOwned(stat, mapping)) {
            const stopR = await stopAndRemove(existing)
            socketRecords.delete(mapping.username)
            if (!stopR.success) {
              failures.push(`${mapping.username}: ${stopR.errorMessage}`)
              continue
            }
          } else {
            if (!statModeIsPrivate(stat)) await filesystemChmodNoFollow(existing.path, socketMode)
            const verified = await safeLstat(existing.path)
            if (
              verified === undefined ||
              verified.type !== "socket" ||
              !statIsSocketOwned(verified, mapping) ||
              !statModeIsPrivate(verified)
            ) {
              cleanupRecordTrack(existing)
              failures.push(`${mapping.username}: socket permissions could not be verified`)
            }
            continue
          }
        } catch (error) {
          cleanupRecordTrack(existing)
          failures.push(`${mapping.username}: ${errorMessage(error)}`)
          continue
        }
      }
      const pathR = socketPath(directoryR.data, mapping.username)
      if (!pathR.success) {
        failures.push(`${mapping.username}: ${pathR.errorMessage}`)
        continue
      }
      if (cleanupRecordPending(pathR.data)) {
        failures.push(`${mapping.username}: socket cleanup remains pending`)
        continue
      }
      const createdR = await socketCreate(directoryR.data, mapping)
      if (!createdR.success) {
        failures.push(`${mapping.username}: ${createdR.errorMessage}`)
        continue
      }
      socketRecords.set(mapping.username, createdR.data)
      created.push(mapping.username)
    }

    try {
      const entries = await filesystem.readdir(directoryR.data)
      for (const entry of entries) {
        if (!entry.endsWith(".sock")) continue
        const username = entry.slice(0, -5)
        if (!usernameIsSafe(username)) {
          failures.push(`${entry}: refusing an unsafe socket name`)
          continue
        }
        if (current.has(username) || socketRecords.has(username)) continue
        const pathR = socketPath(directoryR.data, username)
        if (!pathR.success) {
          failures.push(`${entry}: ${pathR.errorMessage}`)
          continue
        }
        const stat = await safeLstat(pathR.data)
        if (stat?.type === "symlink") failures.push(`${entry}: refusing a symbolic link`)
        else if (stat !== undefined && stat.type !== "socket")
          failures.push(`${entry}: refusing a non-socket stale path`)
        else if (stat?.type === "socket") {
          const ownerR = await posixUserResolve(username)
          if (ownerR.success && statIsSocketOwned(stat, ownerR.data)) {
            const staleRecord: SocketRecord = {
              path: pathR.data,
              mapping: ownerR.data,
              server: { stop: () => undefined },
            }
            const removeR = await removeOwnedSocket(staleRecord)
            if (!removeR.success) {
              cleanupRecordTrack(staleRecord)
              failures.push(`${entry}: ${removeR.errorMessage}`)
            } else removed.push(username)
          } else if (!ownerR.success) {
            // A missing user does not prove who owned a stale socket. Leave it alone.
          } else {
            failures.push(`${entry}: refusing an unowned stale socket`)
          }
        }
      }
    } catch (error) {
      failures.push(`socket directory scan failed: ${errorMessage(error)}`)
    }

    socketStateReady = failures.length === 0 && missingUsers.length === 0
    const refresh: ProjectRegistryDaemonSocketRefresh = {
      created,
      removed,
      current: [...socketRecords.keys()],
      missingUsers,
    }
    if (failures.length > 0) return createResultError("projectRegistryDaemonSocketsRefresh", failures.join("; "))
    return createResult(refresh)
  }

  function refreshSockets(): PromiseResult<ProjectRegistryDaemonSocketRefresh> {
    if (state === "stopping" || state === "stopped" || state === "failed") {
      return Promise.resolve(createResultError("projectRegistryDaemonSocketsRefresh", "daemon is not accepting work"))
    }
    if (socketRefreshPromise !== undefined) return socketRefreshPromise
    const current = Promise.resolve().then(refreshSocketsInternal)
    socketRefreshPromise = current
    void current.then(
      () => {
        if (socketRefreshPromise === current) socketRefreshPromise = undefined
      },
      () => {
        if (socketRefreshPromise === current) socketRefreshPromise = undefined
      },
    )
    return current
  }

  function browserProjectAccessCreate(
    actor: Actor,
    sessionId: string,
    request: Request,
    browserAuth: ProjectRegistryDaemonBrowserAuth,
  ): ProjectAccess {
    const sharedAccess = projectAccessCreate({
      identityDirectory: browserAuth.identityDirectory,
      posixUsers: browserAuth.posixUsers,
      transport: {
        transport: "browser",
        sessionId,
        sessions: browserAuth.sessions,
        tokenReferences: browserAuth.tokenReferences,
        signal: request.signal,
        timeoutMs: browserAuth.timeoutMs,
      },
    })
    return {
      actorResolve: async () => createResult(actor),
      ownerRoleResolve: sharedAccess.ownerRoleResolve,
    }
  }

  async function browserRequestContextResolve(
    request: Request,
    context: Extract<ProjectRegistryDaemonRequestContext, { transport: "http" }>,
    browserAuth: ProjectRegistryDaemonBrowserAuth,
  ): Promise<ProjectRegistryDaemonRequestContext> {
    if (context.access !== undefined) return context
    const sessionR = await sessionRequestResolve(
      request.headers.get("cookie"),
      browserAuth.sessions,
      browserAuth.cookie,
      {
        signal: request.signal,
        timeoutMs: browserAuth.timeoutMs,
      },
    )
    if (!sessionR.success) return context
    const actorR = await sessionActorResolve(sessionR.data.id, {
      sessions: browserAuth.sessions,
      tokenReferences: browserAuth.tokenReferences,
      identityDirectory: browserAuth.identityDirectory,
      posixUsers: browserAuth.posixUsers,
      signal: request.signal,
      timeoutMs: browserAuth.timeoutMs,
    })
    if (!actorR.success) return context
    return {
      ...context,
      access: browserProjectAccessCreate(actorR.data, sessionR.data.id, request, browserAuth),
    }
  }

  function handleRequest(request: Request, context: ProjectRegistryDaemonRequestContext): Response | Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health/live") {
      return Response.json(healthLive(), { status: healthLive().live ? 200 : 503 })
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/health/ready") {
      return readiness().then((readinessR) => {
        const data = readinessR.success
          ? readinessR.data
          : {
              ready: false,
              state,
              repositoryReady: false,
              listenersReady: false,
              socketsReady: false,
              caddyReady: false,
              reason: readinessR.errorMessage,
            }
        return Response.json(data, { status: data.ready ? 200 : 503 })
      })
    }
    if (state !== "running") return new Response("Service unavailable", { status: 503 })
    const handleResolvedRequest = (
      requestContext: ProjectRegistryDaemonRequestContext,
    ): Response | Promise<Response> => {
      try {
        return handler(request, requestContext)
      } catch {
        return new Response("Internal server error", { status: 500 })
      }
    }
    if (context.transport !== "http" || browserAuthOption === undefined) return handleResolvedRequest(context)
    return browserRequestContextResolve(request, context, browserAuthOption)
      .then(handleResolvedRequest)
      .catch(() => new Response("Internal server error", { status: 500 }))
  }

  async function awaitBeforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      void operation.then(
        () => undefined,
        () => undefined,
      )
      return false
    }

    let clearTimeout: (() => void) | undefined
    const timeout = new Promise<false>((resolveTimeout) => {
      const schedule = timerOption?.setTimeout
      if (schedule !== undefined) {
        const handle = schedule(() => resolveTimeout(false), remaining)
        clearTimeout = () => timerOption?.clearTimeout?.(handle)
        return
      }
      const handle = globalThis.setTimeout(() => resolveTimeout(false), remaining)
      clearTimeout = () => globalThis.clearTimeout(handle)
    })
    try {
      const completed = await Promise.race([
        operation.then(
          () => true as const,
          () => true as const,
        ),
        timeout,
      ])
      clearTimeout?.()
      return completed
    } catch {
      clearTimeout?.()
      return true
    }
  }

  async function stopResourcesInternal(): Promise<string[]> {
    const failures: string[] = []
    if (userRefreshHandle !== undefined) {
      try {
        timer.clearInterval(userRefreshHandle)
      } catch (error) {
        failures.push(`user refresh timer: ${errorMessage(error)}`)
      }
      userRefreshHandle = undefined
    }
    while (signalCleanups.length > 0) {
      const cleanup = signalCleanups.pop()
      try {
        cleanup?.()
      } catch (error) {
        failures.push(`signal cleanup: ${errorMessage(error)}`)
      }
    }
    signalsInstalled = false

    const records = new Map<string, SocketRecord>()
    for (const record of cleanupRecords.values()) records.set(record.path, record)
    for (const record of socketRecords.values()) records.set(record.path, record)
    socketRecords.clear()

    const recordResultsPromise = Promise.all(
      [...records.values()].map(async (record) => ({ record, result: await stopAndRemove(record) })),
    )
    const currentWebServer = webServer
    const webServerResultPromise =
      currentWebServer === undefined
        ? Promise.resolve<string | undefined>(undefined)
        : serverStopOnce(currentWebServer).then(
            () => {
              if (webServer === currentWebServer) webServer = undefined
              return undefined
            },
            (error) => `web listener: ${errorMessage(error)}`,
          )
    const lateServerResultsPromise = Promise.all(
      [...lateServerHandles].map(async (server) => {
        try {
          await serverStopOnce(server)
          lateServerHandles.delete(server)
          return undefined
        } catch (error) {
          return `late server: ${errorMessage(error)}`
        }
      }),
    )
    const [recordResults, webServerFailure, lateServerResults] = await Promise.all([
      recordResultsPromise,
      webServerResultPromise,
      lateServerResultsPromise,
    ])
    for (const { record, result } of recordResults) {
      if (!result.success) failures.push(`${record.mapping.username}: ${result.errorMessage}`)
    }
    if (webServerFailure !== undefined) failures.push(webServerFailure)
    for (const failure of lateServerResults) {
      if (failure !== undefined) failures.push(failure)
    }
    return failures
  }

  function stopResources(): Promise<string[]> {
    if (resourceCleanupPromise !== undefined) return resourceCleanupPromise
    const current = stopResourcesInternal()
    resourceCleanupPromise = current
    void current.then(
      (failures) => {
        if (failures.length > 0 && resourceCleanupPromise === current) resourceCleanupPromise = undefined
      },
      () => {
        if (resourceCleanupPromise === current) resourceCleanupPromise = undefined
      },
    )
    return current
  }

  function gitQueueRun<T>(operation: string, run: () => PromiseResult<T>): PromiseResult<T> {
    if (state === "stopping" || state === "stopped" || state === "failed") {
      return Promise.resolve(createResultError(operation, "project-registryd is shutting down"))
    }
    const previous = gitTail
    const result = previous.then(async () => {
      try {
        return await run()
      } catch (error) {
        return createResultError(operation, errorMessage(error))
      }
    })
    gitTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const guardedRepository: ProjectRepository = {
    read: () => gitQueueRun("projectRegistryRepositoryRead", () => repository.read()),
    get: (key) => gitQueueRun("projectRegistryRepositoryGet", () => repository.get(key)),
    create: (project, mutationOptions) =>
      gitQueueRun("projectRegistryRepositoryCreate", () => repository.create(project, mutationOptions)),
    edit: (key, project, mutationOptions) =>
      gitQueueRun("projectRegistryRepositoryEdit", () => repository.edit(key, project, mutationOptions)),
    delete: (key, mutationOptions) =>
      gitQueueRun("projectRegistryRepositoryDelete", () => repository.delete(key, mutationOptions)),
    history: (key, limit) => gitQueueRun("projectRegistryRepositoryHistory", () => repository.history(key, limit)),
    ownerHistory: (owner, limit) =>
      gitQueueRun("projectRegistryRepositoryOwnerHistory", () => repository.ownerHistory(owner, limit)),
    readiness: () => repository.readiness(),
    recover: () => gitQueueRun("projectRegistryRepositoryRecover", () => repository.recover()),
  }
  const accessLogSourceR =
    accessLogSourceOption !== undefined
      ? createResult(accessLogSourceOption)
      : config.caddyAccessLogRoot === undefined
        ? undefined
        : projectAccessLogSourceFileCreate({ root: config.caddyAccessLogRoot, maxRecords: 1_000 })
  const socketAccessResolve =
    socketAccessResolveOption ??
    (async (username: string) =>
      createResultError("projectRegistryDaemonSocketAccessResolve", "socket actor role is unavailable", username))
  const handler =
    requestHandlerOption ??
    projectRegistryApiHandlerCreate({
      repository: guardedRepository,
      caddyApplication,
      ...(accessLogSourceR?.success === true ? { projectAccessLogSource: accessLogSourceR.data } : {}),
      socketAccessResolve,
      configOptions: {
        httpsListener: config.httpsListener,
        oidc: config.oidc,
        ...(config.caddyAccessLogRoot === undefined ? {} : { caddyAccessLogRoot: config.caddyAccessLogRoot }),
      },
      portRange: config.portRange,
    })

  function caddyStop(): Promise<string[]> {
    if (!caddyStartAttempted) return Promise.resolve([])
    if (caddyStopPromise !== undefined) return caddyStopPromise
    const current = Promise.resolve()
      .then(() => caddyApplication.stop())
      .then(
        () => [],
        (error) => [`Caddy application shutdown: ${errorMessage(error)}`],
      )
    caddyStopPromise = current
    void current.then(
      (failures) => {
        if (failures.length > 0 && caddyStopPromise === current) caddyStopPromise = undefined
      },
      () => {
        if (caddyStopPromise === current) caddyStopPromise = undefined
      },
    )
    return current
  }

  function signalsInstall(): Result<void> {
    if (signalsInstalled) return createResult(undefined)
    const cleanups: Array<() => void> = []
    try {
      const onSignal = () => {
        void shutdown().then(
          () => undefined,
          () => undefined,
        )
      }
      cleanups.push(signals.on("SIGINT", onSignal))
      cleanups.push(signals.on("SIGTERM", onSignal))
      signalCleanups.push(...cleanups)
      signalsInstalled = true
      return createResult(undefined)
    } catch {
      while (cleanups.length > 0) {
        try {
          cleanups.pop()?.()
        } catch {
          // Signal installation has already failed.
        }
      }
      return createResultError(op, "daemon signal setup failed")
    }
  }

  async function startupRollback(): Promise<string[]> {
    const rollback = Promise.all([caddyStop(), stopResources()]).then(([caddyFailures, resourceFailures]) => [
      ...caddyFailures,
      ...resourceFailures,
    ])
    const deadline = Date.now() + config.shutdownTimeoutMs
    if (!(await awaitBeforeDeadline(rollback, deadline))) return ["daemon startup rollback timed out"]
    try {
      return await rollback
    } catch {
      return ["daemon startup rollback failed"]
    }
  }

  async function startupFailure(message: string): PromiseResult<void> {
    let rollbackFailed = false
    try {
      rollbackFailed = (await startupRollback()).length > 0
    } catch {
      rollbackFailed = true
    }
    if (!daemonStopping()) state = "failed"
    const result = createResultError(op, rollbackFailed ? "daemon startup rollback failed" : message)
    if (state === "failed") terminationSettle(result)
    return result
  }

  async function readiness(): PromiseResult<ProjectRegistryDaemonReadiness> {
    if (state !== "running") {
      return createResult({
        ready: false,
        state,
        repositoryReady: false,
        listenersReady: false,
        socketsReady: false,
        caddyReady: false,
        reason: state === "stopping" ? "daemon is shutting down" : "daemon is not running",
      })
    }

    let repositoryReady = false
    let reason: string | undefined
    try {
      const repositoryR = await repository.readiness()
      if (!repositoryR.success) reason = repositoryR.errorMessage
      else {
        repositoryReady = repositoryR.data.ready
        reason = repositoryR.data.reason
      }
    } catch {
      reason = "repository readiness unavailable"
    }

    const listenersReady = webServer !== undefined
    let caddyReady = false
    try {
      const status = caddyApplication.status()
      caddyReady = caddyStarted && !status.pending && status.error === undefined
      if (!caddyReady && status.error !== undefined && reason === undefined) {
        reason = "Caddy application is not ready"
      }
    } catch {
      reason = reason ?? "Caddy status unavailable"
    }
    const ready = repositoryReady && listenersReady && socketStateReady && caddyReady
    if (!ready && reason === undefined) reason = "one or more runtime dependencies are not ready"
    return createResult({
      ready,
      state,
      repositoryReady,
      listenersReady,
      socketsReady: socketStateReady,
      caddyReady,
      reason,
    })
  }

  async function startInternal(): PromiseResult<void> {
    if (state !== "starting") return createResultError(op, "daemon has stopped")
    const signalsR = signalsInstall()
    if (!signalsR.success) return startupFailure(signalsR.errorMessage)

    const rootR = await rootCheck()
    if (!rootR.success) return startupFailure(rootR.errorMessage)
    try {
      const webR = await serverCreate({
        hostname: config.webListener.hostname,
        port: config.webListener.port,
        fetch: (request) => handleRequest(request, { transport: "http" }),
      })
      if (!webR.success) return startupFailure(webR.errorMessage)
      webServer = webR.data
      if (state !== "starting") return startupFailure("daemon shutdown started")

      const socketsR = await refreshSockets()
      if (!socketsR.success) return startupFailure(socketsR.errorMessage)
      if (state !== "starting") return startupFailure("daemon shutdown started")

      caddyStartAttempted = true
      const caddyR = await caddyApplication.startup()
      if (!caddyR.success) return startupFailure(caddyR.errorMessage)
      caddyStarted = true
      if (state !== "starting") return startupFailure("daemon shutdown started")

      try {
        userRefreshHandle = timer.setInterval(() => {
          if (state === "running") void refreshSockets()
        }, config.userRefreshIntervalMs)
      } catch {
        return startupFailure("daemon timer setup failed")
      }
      if (state !== "starting") return startupFailure("daemon shutdown started")
      state = "running"
      return createResult(undefined)
    } catch {
      return startupFailure("daemon startup failed")
    }
  }

  function start(): PromiseResult<void> {
    if (startPromise !== undefined) return startPromise
    if (state === "stopped" || state === "stopping") return Promise.resolve(createResultError(op, "daemon has stopped"))
    state = "starting"
    const current = Promise.resolve()
      .then(startInternal)
      .catch(async () => startupFailure("daemon startup failed"))
    startPromise = current
    return current
  }

  async function shutdownWork(): Promise<string[]> {
    const operations: Array<Promise<string[]>> = [
      gitTail.then(
        () => [],
        () => ["Git queue did not complete"],
      ),
      caddyStop(),
    ]
    const currentSocketRefresh = socketRefreshPromise
    if (currentSocketRefresh !== undefined) {
      operations.push(
        currentSocketRefresh.then(
          (result) => (result.success ? [] : ["socket refresh did not complete"]),
          () => ["socket refresh did not complete"],
        ),
      )
    }
    const results = await Promise.all(operations)
    return results.flat()
  }

  async function shutdownInternal(): PromiseResult<void> {
    state = "stopping"
    const deadline = Date.now() + config.shutdownTimeoutMs
    const failures: string[] = []
    const work = shutdownWork()
    if (await awaitBeforeDeadline(work, deadline)) {
      failures.push(...((await work.catch(() => ["shutdown work failed"])) as string[]))
    } else {
      failures.push("shutdown timed out")
    }

    const cleanup = stopResources()
    if (await awaitBeforeDeadline(cleanup, deadline)) {
      failures.push(...((await cleanup.catch(() => ["resource cleanup failed"])) as string[]))
    } else {
      failures.push("resource cleanup timed out")
    }
    if (webServer !== undefined || lateServerHandles.size > 0 || cleanupRecords.size > 0) {
      failures.push("resource cleanup remains pending")
    }
    state = "stopped"
    const result =
      failures.length > 0
        ? createResultError("projectRegistryDaemonShutdown", "daemon shutdown degraded")
        : createResult(undefined)
    terminationSettle(result)
    return result
  }

  function shutdown(): PromiseResult<void> {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownSettled = false
    const current = Promise.resolve()
      .then(shutdownInternal)
      .catch(() => {
        state = "stopped"
        const result = createResultError("projectRegistryDaemonShutdown", "daemon shutdown degraded")
        terminationSettle(result)
        return result
      })
    shutdownPromise = current.then((result) => {
      shutdownSettled = true
      if (result.success && (webServer !== undefined || lateServerHandles.size > 0 || cleanupRecords.size > 0)) {
        shutdownPromise = undefined
        resourceCleanupPromise = undefined
        shutdownSettled = false
      }
      if (!result.success) shutdownPromise = undefined
      return result
    })
    return shutdownPromise
  }

  const daemon: ProjectRegistryDaemon = {
    config,
    repository: guardedRepository,
    caddyApplication,
    start,
    shutdown,
    termination: () => terminationPromise,
    healthLive,
    readiness,
    refreshSockets,
  }
  return createResult(daemon)
}
