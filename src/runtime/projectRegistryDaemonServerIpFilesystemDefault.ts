import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises"
import type { ProjectRegistryDaemonServerIpFilesystem } from "./ProjectRegistryDaemonServerIpFilesystem.js"

export function projectRegistryDaemonServerIpFilesystemDefault(): ProjectRegistryDaemonServerIpFilesystem {
  return {
    async readFile(path) {
      return fsReadFile(path, "utf8")
    },
    async mkdir(path, mode) {
      await fsMkdir(path, { recursive: true, mode })
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
