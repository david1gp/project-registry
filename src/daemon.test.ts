import { describe, expect, test } from "bun:test"
import { projectRegistryDaemonRun } from "./daemon.js"

describe("projectRegistryDaemonRun", () => {
  test("renders verbose local metadata without starting", async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await projectRegistryDaemonRun(["--version", "--verbose"], {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }),
    ).toBe(0)
    expect(stdout.join("")).toContain("project-registryd ")
    expect(stdout.join("")).toContain("user agent: @adaptive-ds/project-registry/")
    expect(stdout.join("")).toContain("installation type: development checkout")
    expect(stderr).toEqual([])
  })

  test("returns a failure code for invalid startup configuration", async () => {
    const previous = Bun.env.PROJECT_REGISTRY_REPOSITORY_PATH
    delete Bun.env.PROJECT_REGISTRY_REPOSITORY_PATH
    try {
      expect(await projectRegistryDaemonRun()).toBe(1)
    } finally {
      if (previous === undefined) delete Bun.env.PROJECT_REGISTRY_REPOSITORY_PATH
      else Bun.env.PROJECT_REGISTRY_REPOSITORY_PATH = previous
    }
  })
})
