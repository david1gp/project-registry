import { describe, expect, test } from "bun:test"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import type { DevRoot } from "./DevRoot.js"
import { devRootDirectoryResolve } from "./devRootDirectoryResolve.js"

function filesystemCreate(directories: string[], realpaths: Record<string, string> = {}): DevProjectFilesystem {
  const roots = ["/projects", "/scratch"]
  return {
    readFile: async () => {
      throw new Error("unreachable")
    },
    realpath: async (path) => {
      const mapped = realpaths[path] ?? path
      if (!roots.includes(mapped) && !directories.includes(mapped)) throw new Error(`ENOENT: ${path}`)
      return mapped
    },
    stat: async () => ({ isDirectory: () => true }),
  }
}

const roots: DevRoot[] = [
  { path: "/projects", users: ["leo", "david", "tim", "mit"] },
  { path: "/scratch", users: ["leo"] },
]

describe("devRootDirectoryResolve", () => {
  test("finds the project in the single allowed root holding it", async () => {
    const result = await devRootDirectoryResolve({
      roots,
      user: "tim",
      project: "archive",
      filesystem: filesystemCreate(["/projects/archive"]),
    })

    expect(result).toEqual({ success: true, data: { root: "/projects", directory: "/projects/archive" } })
  })

  test("never searches a root the caller is not allowlisted for", async () => {
    const result = await devRootDirectoryResolve({
      roots,
      user: "tim",
      project: "notes",
      filesystem: filesystemCreate(["/scratch/notes"]),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.not-found")
  })

  test("an explicitly requested root outside the allowlist is forbidden", async () => {
    const result = await devRootDirectoryResolve({
      roots,
      user: "tim",
      project: "notes",
      rootPath: "/scratch",
      filesystem: filesystemCreate(["/scratch/notes"]),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.forbidden")
  })

  test("a name present in several allowed roots is a conflict until --root picks one", async () => {
    const filesystem = filesystemCreate(["/projects/archive", "/scratch/archive"])
    const ambiguous = await devRootDirectoryResolve({ roots, user: "leo", project: "archive", filesystem })

    expect(ambiguous.success).toBe(false)
    if (ambiguous.success) return
    expect(ambiguous.code).toBe("projects.conflict")
    expect(ambiguous.errorMessage).toContain("--root")

    const picked = await devRootDirectoryResolve({
      roots,
      user: "leo",
      project: "archive",
      rootPath: "/scratch/",
      filesystem,
    })
    expect(picked).toEqual({ success: true, data: { root: "/scratch", directory: "/scratch/archive" } })
  })

  test("a symlink escape in any allowed root is forbidden, not skipped", async () => {
    const result = await devRootDirectoryResolve({
      roots,
      user: "leo",
      project: "archive",
      filesystem: filesystemCreate(["/scratch/archive", "/etc"], { "/projects/archive": "/etc" }),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.forbidden")
  })

  test("legacy roots without an allowlist admit every caller", async () => {
    const result = await devRootDirectoryResolve({
      roots: [{ path: "/projects" }],
      user: "anyone",
      project: "archive",
      filesystem: filesystemCreate(["/projects/archive"]),
    })

    expect(result.success).toBe(true)
  })
})
