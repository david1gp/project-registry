import {
  chmod,
  chown,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  realpath as fsRealpath,
  lchmod,
  lchown,
  unlink,
} from "node:fs/promises"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"
import type { ProjectRegistryDaemonFilesystem } from "./ProjectRegistryDaemonFilesystem.js"

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

export function projectRegistryDaemonFilesystemDefault(): ProjectRegistryDaemonFilesystem {
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
    async mkdir(path, mode) {
      await fsMkdir(path, { mode, recursive: true })
    },
    async readdir(path) {
      return fsReaddir(path)
    },
    async chmod(path, mode) {
      await chmod(path, mode)
    },
    async chown(path, uid, gid) {
      await chown(path, uid, gid)
    },
    async chmodNoFollow(path, mode) {
      await lchmod(path, mode)
    },
    async chownNoFollow(path, uid, gid) {
      await lchown(path, uid, gid)
    },
    async unlink(path) {
      await unlink(path)
    },
  }
}
