import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { IdentityDirectoryUser } from "../identity/IdentityDirectoryUser.js"
import { preferredUsernameMap } from "../identity/preferredUsernameMap.js"
import { userRoleResolve } from "../identity/userRoleResolve.js"
import { clockNowResolve } from "../runtime/clockNowResolve.js"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { SessionActorResolveOptions } from "../session/SessionActorResolveOptions.js"
import { sessionActorResolve } from "../session/sessionActorResolve.js"
import { sessionRecordValidate } from "../session/sessionRecordValidate.js"
import { tokenReferenceTokensValidate } from "../session/tokenReferenceTokensValidate.js"
import type { Actor } from "./Actor.js"
import type { ProjectAccess } from "./ProjectAccess.js"
import type { ProjectAccessCreateOptions } from "./ProjectAccessCreateOptions.js"
import type { Role } from "./Role.js"

type CurrentIdentity = {
  actor: Actor
  accessToken: string
}

type OperationOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

const maximumUsers = 10_000

function stringIsBounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function operationOptionsResolve(options: ProjectAccessCreateOptions): OperationOptions {
  const transport = options.transport
  return {
    timeoutMs: transport.timeoutMs ?? options.timeoutMs,
    signal: transport.signal ?? options.signal,
  }
}

function identityUserValidate(value: unknown): Result<IdentityDirectoryUser> {
  const op = "projectAccessIdentityUserValidate"
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createResultError(op, "identity mapping is unavailable")
  }
  const user = value as Record<string, unknown>
  if (!stringIsBounded(user.subject, 256) || !stringIsBounded(user.preferredUsername, 256)) {
    return createResultError(op, "identity mapping is unavailable")
  }
  return createResult({ subject: user.subject, preferredUsername: user.preferredUsername })
}

function identityUsersValidate(value: unknown): Result<readonly IdentityDirectoryUser[]> {
  const op = "projectAccessIdentityUsersResolve"
  if (!Array.isArray(value) || value.length > maximumUsers) {
    return createResultError(op, "identity mapping is unavailable")
  }
  const subjects = new Set<string>()
  const usernames = new Set<string>()
  const users: IdentityDirectoryUser[] = []
  for (const entry of value) {
    const userR = identityUserValidate(entry)
    if (!userR.success) return userR
    if (subjects.has(userR.data.subject) || usernames.has(userR.data.preferredUsername)) {
      return createResultError(op, "identity mapping is unavailable")
    }
    subjects.add(userR.data.subject)
    usernames.add(userR.data.preferredUsername)
    users.push(userR.data)
  }
  return createResult(users)
}

async function identityUsersResolve(
  accessToken: string,
  options: ProjectAccessCreateOptions,
): PromiseResult<readonly IdentityDirectoryUser[]> {
  const operationOptions = operationOptionsResolve(options)
  if (!stringIsBounded(accessToken, 8_192)) {
    return createResultError("projectAccessIdentityUsersResolve", "identity mapping is unavailable")
  }
  try {
    const usersR = await promiseBoundedRace(
      Promise.resolve().then(() => options.identityDirectory.usersList(accessToken)),
      operationOptions,
    )
    if (!usersR.success || !usersR.data.success) {
      return createResultError("projectAccessIdentityUsersResolve", "identity mapping is unavailable")
    }
    return identityUsersValidate(usersR.data.data)
  } catch {
    return createResultError("projectAccessIdentityUsersResolve", "identity mapping is unavailable")
  }
}

async function browserIdentityResolve(
  options: ProjectAccessCreateOptions & {
    transport: Extract<ProjectAccessCreateOptions["transport"], { transport: "browser" }>
  },
): PromiseResult<CurrentIdentity> {
  const operationOptions = operationOptionsResolve(options)
  const actorOptions: SessionActorResolveOptions = {
    sessions: options.transport.sessions,
    tokenReferences: options.transport.tokenReferences,
    identityDirectory: options.identityDirectory,
    posixUsers: options.posixUsers,
    ...(options.transport.clock === undefined ? {} : { clock: options.transport.clock }),
    ...operationOptions,
  }
  const actorR = await sessionActorResolve(options.transport.sessionId, actorOptions)
  if (!actorR.success) return actorR

  try {
    const sessionR = await promiseBoundedRace(
      Promise.resolve().then(() => options.transport.sessions.resolve(options.transport.sessionId)),
      operationOptions,
    )
    if (!sessionR.success || !sessionR.data.success) {
      return createResultError("projectAccessCurrentIdentityResolve", "session identity is unavailable")
    }
    const sessionRecordR = sessionRecordValidate(sessionR.data.data)
    if (!sessionRecordR.success || sessionRecordR.data.id !== options.transport.sessionId) {
      return createResultError("projectAccessCurrentIdentityResolve", "session identity is unavailable")
    }

    const tokenR = await promiseBoundedRace(
      Promise.resolve().then(() => options.transport.tokenReferences.resolve(sessionRecordR.data.tokenReference)),
      operationOptions,
    )
    if (!tokenR.success || !tokenR.data.success) {
      return createResultError("projectAccessCurrentIdentityResolve", "session identity is unavailable")
    }
    const tokensR = tokenReferenceTokensValidate(tokenR.data.data)
    const nowR = clockNowResolve(options.transport.clock ?? Date.now)
    if (!tokensR.success || !nowR.success) {
      return createResultError("projectAccessCurrentIdentityResolve", "session identity is unavailable")
    }
    if (sessionRecordR.data.expiresAt <= nowR.data || tokensR.data.expiresAt <= nowR.data) {
      return createResultError("projectAccessCurrentIdentityResolve", "session identity is unavailable")
    }
    if (actorR.data.subject !== sessionRecordR.data.subject || actorR.data.username !== sessionRecordR.data.username) {
      return createResultError("projectAccessCurrentIdentityResolve", "session identity is unavailable")
    }
    return createResult({ actor: actorR.data, accessToken: tokensR.data.accessToken })
  } catch {
    return createResultError("projectAccessCurrentIdentityResolve", "session identity is unavailable")
  }
}

async function unixIdentityResolve(
  options: ProjectAccessCreateOptions & {
    transport: Extract<ProjectAccessCreateOptions["transport"], { transport: "unix" }>
  },
): PromiseResult<CurrentIdentity> {
  const username = options.transport.username
  if (!stringIsBounded(username, 256)) {
    return createResultError("projectAccessCurrentIdentityResolve", "socket actor mapping is unavailable")
  }
  const usersR = await identityUsersResolve(options.transport.accessToken, options)
  if (!usersR.success) {
    return createResultError("projectAccessCurrentIdentityResolve", "socket actor mapping is unavailable")
  }
  const matches = usersR.data.filter((user) => user.preferredUsername === username)
  if (matches.length !== 1) {
    return createResultError("projectAccessCurrentIdentityResolve", "socket actor mapping is unavailable")
  }
  const user = matches[0]!
  const usernameR = await preferredUsernameMap(
    user.preferredUsername,
    options.posixUsers,
    operationOptionsResolve(options),
  )
  if (!usernameR.success || usernameR.data !== username) {
    return createResultError("projectAccessCurrentIdentityResolve", "socket actor mapping is unavailable")
  }
  const roleR = await userRoleResolve(
    user.subject,
    options.transport.accessToken,
    options.identityDirectory,
    operationOptionsResolve(options),
  )
  if (!roleR.success) return createResultError("projectAccessCurrentIdentityResolve", "current role is unavailable")
  return createResult({
    actor: { subject: user.subject, username, role: roleR.data },
    accessToken: options.transport.accessToken,
  })
}

async function currentIdentityResolve(options: ProjectAccessCreateOptions): PromiseResult<CurrentIdentity> {
  if (options.transport.transport === "browser") {
    return browserIdentityResolve(
      options as ProjectAccessCreateOptions & {
        transport: Extract<ProjectAccessCreateOptions["transport"], { transport: "browser" }>
      },
    )
  }
  if (options.transport.transport === "unix") {
    return unixIdentityResolve(
      options as ProjectAccessCreateOptions & {
        transport: Extract<ProjectAccessCreateOptions["transport"], { transport: "unix" }>
      },
    )
  }
  return createResultError("projectAccessCurrentIdentityResolve", "current identity is unavailable")
}

async function ownerRoleResolve(owner: string, options: ProjectAccessCreateOptions): PromiseResult<Role | undefined> {
  const identityR = await currentIdentityResolve(options)
  if (!identityR.success) return identityR
  if (!stringIsBounded(owner, 256)) {
    return createResultError("projectAccessOwnerRoleResolve", "project owner mapping is unavailable")
  }
  const usersR = await identityUsersResolve(identityR.data.accessToken, options)
  if (!usersR.success) {
    return createResultError("projectAccessOwnerRoleResolve", "project owner role is unavailable")
  }
  const user = usersR.data.find((entry) => entry.preferredUsername === owner)
  if (user === undefined) return createResult(undefined)

  const usernameR = await preferredUsernameMap(
    user.preferredUsername,
    options.posixUsers,
    operationOptionsResolve(options),
  )
  if (!usernameR.success) return createResult(undefined)
  const roleR = await userRoleResolve(
    user.subject,
    identityR.data.accessToken,
    options.identityDirectory,
    operationOptionsResolve(options),
  )
  if (!roleR.success) {
    return createResultError("projectAccessOwnerRoleResolve", "project owner role is unavailable")
  }
  return createResult(roleR.data)
}

export function projectAccessCreate(options: ProjectAccessCreateOptions): ProjectAccess {
  return {
    actorResolve: async () => {
      const identityR = await currentIdentityResolve(options)
      if (!identityR.success) return identityR
      return createResult(identityR.data.actor)
    },
    ownerRoleResolve: (owner) => ownerRoleResolve(owner, options),
  }
}
