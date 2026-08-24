import { createResult, createResultError, type PromiseResult } from "#result"
import type { Actor } from "../access/Actor.js"
import { visibleUserList } from "../access/visibleUserList.js"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { MappedUser } from "./MappedUser.js"
import { preferredUsernameMap } from "./preferredUsernameMap.js"
import { userRoleResolve } from "./userRoleResolve.js"
import type { VisibleUser } from "./VisibleUser.js"
import type { VisibleUserDirectoryListOptions } from "./VisibleUserDirectoryListOptions.js"

const directoryRetryHint = "Retry loading the user directory. If the problem persists, contact an administrator."
const directoryMappingHint = "Ask an administrator to fix the user directory mapping, then retry."
const directorySizeHint = "Ask an administrator to reduce the user directory size, then retry."
const directoryLimitHint = "Ask an administrator to reduce the directory lookup scope, then retry."
const directoryRoleHint =
  "Retry loading the user directory. If the problem persists, ask an administrator to verify user roles."

function directoryError(op: string, hint: string) {
  return { ...createResultError(op, "user directory is unavailable"), hint }
}

function directoryMappingError(op: string) {
  return { ...createResultError(op, "user directory contains an invalid mapping"), hint: directoryMappingHint }
}

function directorySizeError(op: string) {
  return { ...createResultError(op, "user directory is too large"), hint: directorySizeHint }
}

function directoryLimitError(op: string) {
  return { ...createResultError(op, "user directory lookup limit exceeded"), hint: directoryLimitHint }
}

function directoryRoleError(op: string) {
  return { ...createResultError(op, "user directory role lookup is unavailable"), hint: directoryRoleHint }
}

export async function visibleUserDirectoryList(
  actor: Actor,
  options: VisibleUserDirectoryListOptions,
): PromiseResult<VisibleUser[]> {
  const op = "visibleUserDirectoryList"
  if (actor.role === "own") {
    const actorR = visibleUserList(actor, [])
    if (!actorR.success) return directoryError(op, directoryRetryHint)
    return createResult([])
  }
  const maxUsers = options.maxUsers ?? 1_000
  const maxLookupCount = options.maxLookupCount ?? maxUsers * 2
  if (
    typeof options.accessToken !== "string" ||
    options.accessToken.length === 0 ||
    options.accessToken.length > 8192 ||
    !Number.isSafeInteger(maxUsers) ||
    maxUsers < 1 ||
    maxUsers > 10_000 ||
    !Number.isSafeInteger(maxLookupCount) ||
    maxLookupCount < 1 ||
    maxLookupCount > 20_000
  ) {
    return directoryError(op, directoryRetryHint)
  }
  try {
    const usersR = await promiseBoundedRace(
      Promise.resolve().then(() => options.identityDirectory.usersList(options.accessToken)),
      options,
    )
    if (usersR.success !== true || usersR.data.success !== true || !Array.isArray(usersR.data.data)) {
      return directoryError(op, directoryRetryHint)
    }
    if (usersR.data.data.length > maxUsers) {
      return directorySizeError(op)
    }
    const mappedUsers: MappedUser[] = []
    let lookupCount = 0
    for (const user of usersR.data.data) {
      if (
        typeof user !== "object" ||
        user === null ||
        typeof user.subject !== "string" ||
        user.subject.length === 0 ||
        user.subject.length > 256 ||
        typeof user.preferredUsername !== "string" ||
        user.preferredUsername.length === 0 ||
        user.preferredUsername.length > 256
      ) {
        return directoryMappingError(op)
      }
      lookupCount += 1
      if (lookupCount > maxLookupCount) {
        return directoryLimitError(op)
      }
      const usernameR = await preferredUsernameMap(user.preferredUsername, options.posixUsers, options)
      if (!usernameR.success) return directoryMappingError(op)
      lookupCount += 1
      if (lookupCount > maxLookupCount) {
        return directoryLimitError(op)
      }
      const roleR = await userRoleResolve(user.subject, options.accessToken, options.identityDirectory, options)
      if (!roleR.success) return directoryRoleError(op)
      mappedUsers.push({ subject: user.subject, username: usernameR.data, role: roleR.data })
    }
    const visibleR = visibleUserList(actor, mappedUsers)
    if (!visibleR.success) return directoryError(op, directoryRetryHint)
    return createResult(visibleR.data)
  } catch {
    return directoryError(op, directoryRetryHint)
  }
}
