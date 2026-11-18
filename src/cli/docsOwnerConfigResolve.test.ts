import { describe, expect, test } from "bun:test"
import { docsOwnerConfigResolve } from "./docsOwnerConfigResolve.js"
import { projectRegistryCliRun } from "./projectRegistryCliRun.js"

const environment = { USER: "david", HOME: "/home/david", XDG_CONFIG_HOME: "/config" }
const config = JSON.stringify({
  docs: {
    rules: [
      { paths: ["/projects", "~/adaptive"], owner: "leo" },
      { paths: ["/projects/special"], owner: "special" },
    ],
  },
})
const read = async () => config

describe("docs owner config", () => {
  test("ignores a missing config and reports malformed JSON or schema", async () => {
    const missing = await docsOwnerConfigResolve({
      environment,
      cwd: "/projects/x",
      read: async () => {
        throw Object.assign(new Error(), { code: "ENOENT" })
      },
    })
    expect(missing).toMatchObject({ success: true, data: undefined })
    for (const text of ["{", '{"docs":{"rules":[{"paths":[],"owner":"bad/name"}]}}']) {
      expect(await docsOwnerConfigResolve({ environment, cwd: "/projects", read: async () => text })).toMatchObject({
        success: false,
      })
    }
  })

  test.each([
    ["/projects", "/projects", "leo"],
    ["/projects/x", "/projects/x", "leo"],
    ["/projectsX", "/projectsX", undefined],
    ["/home/david/adaptive/x", "/home/david/adaptive/x", "leo"],
    ["/projects/special/x", "/projects/special/x", "special"],
    ["/link/x", "/projects/x", "leo"],
  ])("matches cwd %s with realpath %s", async (cwd, physical, owner) => {
    expect(await docsOwnerConfigResolve({ environment, cwd, read, realpath: async () => physical })).toMatchObject({
      success: true,
      data: owner,
    })
  })

  test.each([
    ["/config", "/config/project-registry/config.json"],
    [undefined, "/home/david/.config/project-registry/config.json"],
    ["", "/home/david/.config/project-registry/config.json"],
  ])("loads the config from XDG_CONFIG_HOME %s or HOME", async (configHome, expected) => {
    let requestedPath: string | undefined
    const result = await docsOwnerConfigResolve({
      environment: { ...environment, XDG_CONFIG_HOME: configHome },
      cwd: "/elsewhere",
      read: async (path) => {
        requestedPath = path
        return config
      },
    })
    expect(result).toMatchObject({ success: true, data: undefined })
    expect(requestedPath).toBe(expected)
  })

  test.each([
    ["/projects/symlink", "/physical/x", "leo"],
    ["/projects/stale", "/unrelated", undefined],
  ])("matches PWD %s only when it resolves to the current directory", async (pwd, physicalPwd, owner) => {
    expect(
      await docsOwnerConfigResolve({
        environment: { ...environment, PWD: pwd },
        cwd: "/physical/x",
        read,
        realpath: async (path) => (path === pwd ? physicalPwd : path),
      }),
    ).toMatchObject({ success: true, data: owner })
  })

  test("keeps the longest normalized rule regardless of order and supports root and bare tilde", async () => {
    const rules = [
      { paths: ["~/adaptive/"], owner: "specific" },
      { paths: ["~"], owner: "home" },
      { paths: ["/"], owner: "root" },
    ]
    for (const [cwd, owner] of [
      ["/home/david/adaptive/x", "specific"],
      ["/home/david", "home"],
      ["/elsewhere", "root"],
    ] as const) {
      expect(
        await docsOwnerConfigResolve({
          environment,
          cwd,
          read: async () => JSON.stringify({ docs: { rules } }),
          realpath: async (path) => path,
        }),
      ).toMatchObject({ success: true, data: owner })
    }
  })

  test("matches the literal cwd when realpath is unavailable", async () => {
    expect(
      await docsOwnerConfigResolve({
        environment,
        cwd: "/projects/x",
        read,
        realpath: async () => {
          throw new Error("inaccessible")
        },
      }),
    ).toMatchObject({ success: true, data: "leo" })
  })

  test.each([
    ["/projects/x", [], "leo"],
    ["/elsewhere", [], "david"],
    ["/projects/x", ["--owner", "override"], "override"],
  ])("publishes from %s to selected owner", async (cwd, extra, owner) => {
    const requests: string[] = []
    const exit = await projectRegistryCliRun(["docs", "README.md", ...extra], {
      environment,
      docsCwd: () => cwd,
      docsConfigRead: read,
      docsRealpath: async (path) => path,
      requestFetch: async (input) => {
        requests.push(new URL(String(input)).pathname)
        return Response.json({ success: true, data: { urls: [], indexUrls: [] } })
      },
      stdout: () => undefined,
    })
    expect(exit).toBe(0)
    expect(requests).toEqual([`/api/v1/users/${owner}/docs/publications`])
  })

  test("invalid config prevents publishing but does not affect unrelated commands", async () => {
    let requests = 0
    const options = {
      environment,
      docsConfigRead: async () => "{",
      requestFetch: async () => {
        requests++
        return Response.json({ success: true, data: [] })
      },
      stdout: () => undefined,
      stderr: () => undefined,
    }
    expect(await projectRegistryCliRun(["docs", "README.md"], options)).toBe(1)
    expect(requests).toBe(0)
    await projectRegistryCliRun(["project", "list"], options)
    expect(requests).toBe(1)
  })

  test("missing config preserves USER and named docs never read owner config", async () => {
    const requests: string[] = []
    let configReads = 0
    const options: NonNullable<Parameters<typeof projectRegistryCliRun>[1]> = {
      environment,
      docsConfigRead: async () => {
        configReads++
        throw Object.assign(new Error("missing"), { code: "ENOENT" })
      },
      requestFetch: async (input) => {
        requests.push(new URL(String(input)).pathname)
        return Response.json({ success: true, data: { urls: [], indexUrls: [] } })
      },
      stdout: () => undefined,
    }
    expect(await projectRegistryCliRun(["docs", "README.md"], options)).toBe(0)
    expect(configReads).toBe(1)
    options.docsConfigRead = async () => {
      throw new Error("named docs must not read config")
    }
    expect(await projectRegistryCliRun(["docs", "site", "guide.md"], options)).toBe(0)
    expect(requests).toEqual(["/api/v1/users/david/docs/publications", "/api/v1/users/david/projects/site/docs"])
  })
})
