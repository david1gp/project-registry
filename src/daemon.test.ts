import { describe, expect, test } from "bun:test"
import { projectRegistryDaemonRun } from "./daemon.js"

describe("projectRegistryDaemonRun", () => {
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
