import {
  chmod as fsChmod,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  rename as fsRename,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises"
import type { ProjectRegistryDaemonCloudflareCredentialsFilesystem } from "./ProjectRegistryDaemonCloudflareCredentialsFilesystem.js"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"

function fileStatType(stat: import("node:fs").Stats): ProjectRegistryDaemonFileStat["type"] {
  if (stat.isDirectory()) return "directory"
  if (stat.isFile()) return "file"
  if (stat.isSocket()) return "socket"
  if (stat.isSymbolicLink()) return "symlink"
  return "other"
}

function fileStatMap(stat: import("node:fs").Stats): ProjectRegistryDaemonFileStat {
  return { type: fileStatType(stat), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}

export function projectRegistryDaemonCloudflareCredentialsFilesystemDefault(): ProjectRegistryDaemonCloudflareCredentialsFilesystem {
  return {
    async lstat(path) {
      try {
        return fileStatMap(await fsLstat(path))
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined
        throw error
      }
    },
    async realpath(path) {
      return fsRealpath(path)
    },
    async readFile(path) {
      return fsReadFile(path, "utf8")
    },
    async mkdir(path, mode) {
      await fsMkdir(path, { recursive: true, mode })
    },
    async chmod(path, mode) {
      await fsChmod(path, mode)
    },
    async writeFile(path, value, mode) {
      await fsWriteFile(path, value, { encoding: "utf8", mode })
    },
    async rename(source, destination) {
      await fsRename(source, destination)
    },
    async unlink(path) {
      await fsUnlink(path)
    },
  }
}
