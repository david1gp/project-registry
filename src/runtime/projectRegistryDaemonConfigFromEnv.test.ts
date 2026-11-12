import { describe, expect, test } from "bun:test"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"

describe("projectRegistryDaemonConfigFromEnv dev flag", () => {
  test("idle expiry is independently opt-in and rejects invalid values", () => {
    for (const [value, expected] of [
      ["false", false],
      ["true", true],
    ] as const) {
      const result = projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
        PROJECT_REGISTRY_DEV_ENABLED: "true",
        PROJECT_REGISTRY_DEV_IDLE_EXPIRY_ENABLED: value,
      })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.dev.idleExpiryEnabled).toBe(expected)
    }
    const invalid = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
      PROJECT_REGISTRY_DEV_IDLE_EXPIRY_ENABLED: "maybe",
    })
    expect(invalid.success).toBe(false)
  })
  test("keeps dev verbs off when the flag is unset", () => {
    const result = projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo" })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.dev).toEqual({ enabled: false })
  })

  test("enables dev verbs for each accepted truthy spelling", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      const result = projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
        PROJECT_REGISTRY_DEV_ENABLED: value,
      })

      expect(result.success).toBe(true)
      if (!result.success) continue
      expect(result.data.dev).toEqual({ enabled: true })
    }
  })

  test("rejects an unparseable flag value", () => {
    const result = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
      PROJECT_REGISTRY_DEV_ENABLED: "maybe",
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("daemon environment contains an invalid number or boolean")
  })

  test("reads the dev projects root and rejects a relative one", () => {
    const rooted = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
      PROJECT_REGISTRY_DEV_ENABLED: "1",
      PROJECT_REGISTRY_DEV_PROJECTS_ROOT: "/projects",
    })
    expect(rooted.success).toBe(true)
    if (!rooted.success) return
    expect(rooted.data.dev).toEqual({ enabled: true, projectsRoot: "/projects" })

    const relative = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
      PROJECT_REGISTRY_DEV_PROJECTS_ROOT: "projects",
    })
    expect(relative.success).toBe(false)
  })
})
