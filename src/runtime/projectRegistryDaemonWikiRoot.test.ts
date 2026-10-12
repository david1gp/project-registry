import { describe, expect, test } from "bun:test"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"

describe("projectRegistryDaemonWikiRoot", () => {
  test("leaves wiki sync disabled when the variable is absent or blank", () => {
    for (const environment of [
      { PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository" },
      { PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository", PROJECT_REGISTRY_WIKI_ROOT: "" },
      { PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository", PROJECT_REGISTRY_WIKI_ROOT: "   " },
    ]) {
      const result = projectRegistryDaemonConfigFromEnv(environment)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.wikiRoot).toBeUndefined()
    }
  })

  test("enables wiki sync for an absolute wiki root", () => {
    expect(
      projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
        PROJECT_REGISTRY_WIKI_ROOT: "/home/leo/wiki",
      }),
    ).toMatchObject({ success: true, data: { wikiRoot: "/home/leo/wiki" } })
  })

  test("rejects relative, empty, and NUL wiki roots", () => {
    for (const wikiRoot of ["relative/wiki", "/home/leo/wi\0ki"]) {
      expect(
        projectRegistryDaemonConfigFromEnv({
          PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repository",
          PROJECT_REGISTRY_WIKI_ROOT: wikiRoot,
        }).success,
      ).toBe(false)
    }
    for (const wikiRoot of ["relative/wiki", "", "/home/leo/wi\0ki"]) {
      expect(projectRegistryDaemonConfigValidate({ repositoryPath: "/tmp/repository", wikiRoot }).success).toBe(false)
    }
  })
})
