import { createResult } from "#result"
import type { ProjectRegistryDaemonMappedUser } from "../runtime/ProjectRegistryDaemonMappedUser.js"
import type { ProjectRegistryDaemonPosix } from "../runtime/ProjectRegistryDaemonPosix.js"
import { projectRegistryDaemonPosixDefault } from "../runtime/projectRegistryDaemonPosixDefault.js"
import type { PosixUserDirectory } from "./PosixUserDirectory.js"

const maximumUsernameLength = 255
const maximumPosixId = 0xffffffff

function usernameIsSafe(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumUsernameLength &&
    /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(value)
  )
}

function mappedUserIsValid(value: unknown, username: string): value is ProjectRegistryDaemonMappedUser {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const user = value as Record<string, unknown>
  return (
    user.username === username &&
    usernameIsSafe(user.username) &&
    typeof user.uid === "number" &&
    Number.isSafeInteger(user.uid) &&
    user.uid >= 0 &&
    user.uid <= maximumPosixId &&
    typeof user.gid === "number" &&
    Number.isSafeInteger(user.gid) &&
    user.gid >= 0 &&
    user.gid <= maximumPosixId
  )
}

function mappedUserResultHasUsername(value: unknown, username: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return result.success === true && mappedUserIsValid(result.data, username)
}

export function posixUserDirectoryCreate(
  posix: ProjectRegistryDaemonPosix = projectRegistryDaemonPosixDefault(),
): PosixUserDirectory {
  return {
    async usernameExists(username) {
      if (!usernameIsSafe(username)) return createResult(false)
      try {
        const userR = await posix.userResolve(username)
        return createResult(mappedUserResultHasUsername(userR, username))
      } catch {
        return createResult(false)
      }
    },
  }
}
