import { appendFile, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { ManagedServiceFilesystem } from "./ManagedServiceFilesystem.js"

export function managedServiceFilesystemDefault(): ManagedServiceFilesystem {
  return {
    async list(directory) {
      return readdir(directory)
    },
    async read(path) {
      try {
        return await readFile(path, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    async writeAtomic(path, content) {
      // Dot-prefixed temp name never matches `proj-*.service`, so a crash
      // mid-write leaves no half unit systemd would load.
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
      await writeFile(temporary, content, { mode: 0o644 })
      await rename(temporary, path)
    },
    async remove(path) {
      await rm(path, { force: true })
    },
    async append(path, content) {
      await appendFile(path, content, { mode: 0o600 })
    },
  }
}
