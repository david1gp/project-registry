import { createResult, createResultError, type PromiseResult } from "#result"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { PosixUserDirectory } from "./PosixUserDirectory.js"

export async function preferredUsernameMap(
  preferredUsername: string,
  posixUsers: PosixUserDirectory,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): PromiseResult<string> {
  const op = "preferredUsernameMap"
  if (typeof preferredUsername !== "string" || preferredUsername.length === 0 || preferredUsername.length > 256) {
    return createResultError(op, "preferred username mapping is unavailable")
  }
  try {
    const existsR = await promiseBoundedRace(
      Promise.resolve().then(() => posixUsers.usernameExists(preferredUsername)),
      options,
    )
    if (existsR.success !== true || existsR.data.success !== true || existsR.data.data !== true) {
      return createResultError(op, "preferred username mapping is unavailable")
    }
    return createResult(preferredUsername)
  } catch {
    return createResultError(op, "preferred username mapping is unavailable")
  }
}
