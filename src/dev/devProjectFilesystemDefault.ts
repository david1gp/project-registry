import { realpath as fsRealpath, readFile as fsReadFile, stat as fsStat } from "node:fs/promises"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"

export function devProjectFilesystemDefault(): DevProjectFilesystem {
  return {
    async readFile(path) {
      return fsReadFile(path, "utf8")
    },
    async realpath(path) {
      return fsRealpath(path)
    },
    async stat(path) {
      return fsStat(path)
    },
  }
}
