import { readFile } from "node:fs/promises"
import { createResult, createResultError } from "#result"
import type { ProjectRegistryDaemonPosix } from "./ProjectRegistryDaemonPosix.js"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function projectRegistryDaemonPosixDefault(): ProjectRegistryDaemonPosix {
  return {
    isRoot: () => typeof process.getuid === "function" && process.getuid() === 0,
    async userResolve(username) {
      const op = "projectRegistryDaemonUserResolve"
      try {
        const passwd = await readFile("/etc/passwd", "utf8")
        const line = passwd.split("\n").find((entry) => entry.split(":", 1)[0] === username)
        if (line === undefined) return createResultError(op, `Linux user ${username} does not exist`)
        const fields = line.split(":")
        const uid = Number(fields[2])
        const gid = Number(fields[3])
        if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
          return createResultError(op, `Linux user ${username} has invalid ownership data`)
        }
        return createResult({ username, uid, gid })
      } catch (error) {
        return createResultError(op, `Linux user lookup failed: ${errorMessage(error)}`)
      }
    },
  }
}
