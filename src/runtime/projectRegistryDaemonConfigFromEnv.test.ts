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

  test("reads per-root dev allowlists, the health timeout, and private DNS wildcard zones", () => {
    const result = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
      PROJECT_REGISTRY_DEV_ENABLED: "1",
      PROJECT_REGISTRY_DEV_ROOTS: "/projects:leo,david,tim,mit",
      PROJECT_REGISTRY_DEV_HEALTH_TIMEOUT_MS: "120000",
      PROJECT_REGISTRY_PRIVATE_DNS_WILDCARD_ZONES: "wonder1.de",
      PROJECT_REGISTRY_PRIVATE_DNS_PUBLIC_PASSTHROUGHS: "assets.coachingcompany.wonder1.de, demos-assets.wonder1.de",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.dev).toEqual({
      enabled: true,
      roots: [{ path: "/projects", users: ["leo", "david", "tim", "mit"] }],
      healthTimeoutMs: 120_000,
    })
    expect(result.data.privateDns.wildcardZones).toEqual(["wonder1.de"])
    expect(result.data.privateDns.publicPassthroughs).toEqual([
      "assets.coachingcompany.wonder1.de",
      "demos-assets.wonder1.de",
    ])
  })

  test("rejects malformed dev roots and wildcard zones outside the zone policy", () => {
    for (const environment of [
      { PROJECT_REGISTRY_DEV_ROOTS: "/projects" },
      { PROJECT_REGISTRY_DEV_ROOTS: "projects:leo" },
      { PROJECT_REGISTRY_DEV_HEALTH_TIMEOUT_MS: "soon" },
      { PROJECT_REGISTRY_PRIVATE_DNS_WILDCARD_ZONES: "example.com" },
    ]) {
      const result = projectRegistryDaemonConfigFromEnv({
        PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
        ...environment,
      })
      expect(result.success).toBe(false)
    }
  })

  test("managed services stay disabled by default with the projects-user defaults", () => {
    const result = projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo" })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.services).toMatchObject({
      enabled: false,
      user: "projects",
      group: "projects",
      homeDirectory: "/home/projects",
      projectsRoot: "/projects",
      allowedUsers: ["leo", "david", "tim", "mit"],
      slice: "projects.slice",
      unitDirectory: "/etc/systemd/system",
    })
  })

  test("managed services read their env overrides and refuse user-mode daemons", () => {
    const result = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo",
      PROJECT_REGISTRY_SERVICES_ENABLED: "true",
      PROJECT_REGISTRY_SERVICES_USER: "svc",
      PROJECT_REGISTRY_SERVICES_ROOT: "/srv/projects",
      PROJECT_REGISTRY_SERVICES_ALLOWED_USERS: "leo, tim",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.services).toMatchObject({
      enabled: true,
      user: "svc",
      homeDirectory: "/home/svc",
      projectsRoot: "/srv/projects",
      allowedUsers: ["leo", "tim"],
    })

    for (const environment of [
      { PROJECT_REGISTRY_SERVICES_ENABLED: "maybe" },
      { PROJECT_REGISTRY_SERVICES_ENABLED: "true", PROJECT_REGISTRY_SERVICES_SLICE: "projects" },
      {
        PROJECT_REGISTRY_SERVICES_ENABLED: "true",
        PROJECT_REGISTRY_MODE: "user",
        USER: "leo",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
    ]) {
      expect(
        projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/repo", ...environment }).success,
      ).toBe(false)
    }
  })
})
