import { createResult, createResultError, type PromiseResult } from "#result"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { PosixUserDirectory } from "./PosixUserDirectory.js"

const mappingHint = "Ask an administrator to verify that your login account maps to a local user, then retry."

function mappingError(op: string) {
  return { ...createResultError(op, "preferred username mapping is unavailable"), hint: mappingHint }
}

export async function preferredUsernameMap(
  preferredUsername: string,
  posixUsers: PosixUserDirectory,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): PromiseResult<string> {
  const op = "preferredUsernameMap"
  if (typeof preferredUsername !== "string" || preferredUsername.length === 0 || preferredUsername.length > 256) {
    return mappingError(op)
  }
  try {
    const existsR = await promiseBoundedRace(
      Promise.resolve().then(() => posixUsers.usernameExists(preferredUsername)),
      options,
    )
    if (existsR.success !== true || existsR.data.success !== true || existsR.data.data !== true) {
      return mappingError(op)
    }
    return createResult(preferredUsername)
  } catch {
    return mappingError(op)
  }
}
