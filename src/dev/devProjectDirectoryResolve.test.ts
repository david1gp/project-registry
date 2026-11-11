import { describe, expect, test } from "bun:test"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import { devProjectDirectoryResolve } from "./devProjectDirectoryResolve.js"

function filesystemCreate(options: {
  realpaths?: Record<string, string>
  directories?: string[]
  realpathError?: string
  statError?: string
}): DevProjectFilesystem {
  return {
    readFile: async () => {
      throw new Error("unreachable")
    },
    realpath: async (path) => {
      if (options.realpathError !== undefined) throw new Error(options.realpathError)
      return options.realpaths?.[path] ?? path
    },
    stat: async (path) => {
      if (options.statError !== undefined) throw new Error(options.statError)
      const directories = options.directories ?? [path]
      return { isDirectory: () => directories.includes(path) }
    },
  }
}

describe("devProjectDirectoryResolve", () => {
  test("resolves the project directory under the configured root", async () => {
    const result = await devProjectDirectoryResolve({
      projectsRoot: "/projects",
      project: "akademie",
      filesystem: filesystemCreate({}),
    })

    expect(result).toEqual({ success: true, data: "/projects/akademie" })
  })

  test("fails closed when the projects root is not configured", async () => {
    const result = await devProjectDirectoryResolve({ project: "akademie", filesystem: filesystemCreate({}) })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe(undefined)
    expect(result.errorMessage).toBe("dev project directory is unavailable")
  })

  test("reports a missing project directory as not found", async () => {
    const result = await devProjectDirectoryResolve({
      projectsRoot: "/projects",
      project: "akademie",
      filesystem: filesystemCreate({ realpathError: "ENOENT" }),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.not-found")
  })

  test("rejects a file where the project directory should be", async () => {
    const result = await devProjectDirectoryResolve({
      projectsRoot: "/projects",
      project: "akademie",
      filesystem: filesystemCreate({ directories: [] }),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("dev.not-found")
  })

  test("rejects a symlink escape outside the projects root", async () => {
    const result = await devProjectDirectoryResolve({
      projectsRoot: "/projects",
      project: "akademie",
      filesystem: filesystemCreate({ realpaths: { "/projects/akademie": "/home/tim/evil" } }),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("dev project directory escapes its projects root")
    expect(result.code).toBe(undefined)
  })

  test("rejects a name that could traverse the root", async () => {
    const result = await devProjectDirectoryResolve({
      projectsRoot: "/projects",
      project: "..",
      filesystem: filesystemCreate({}),
    })

    expect(result.success).toBe(false)
  })
})
