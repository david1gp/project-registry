import { describe, expect, test } from "bun:test"
import { docsOwnerConfigResolve } from "./docsOwnerConfigResolve.js"
import { projectRegistryCliRun } from "./projectRegistryCliRun.js"

const environment = { USER: "david", HOME: "/home/david", XDG_CONFIG_HOME: "/config" }
const config = JSON.stringify({ docs: { rules: [
  { paths: ["/projects", "~/adaptive"], owner: "leo" },
  { paths: ["/projects/special"], owner: "special" },
] } })
const read = async () => config

describe("docs owner config", () => {
  test("ignores a missing config and reports malformed JSON or schema", async () => {
    const missing = await docsOwnerConfigResolve({ environment, cwd: "/projects/x", read: async () => { throw Object.assign(new Error(), { code: "ENOENT" }) } })
    expect(missing).toMatchObject({ success: true, data: undefined })
    for (const text of ["{", '{"docs":{"rules":[{"paths":[],"owner":"bad/name"}]}}']) {
      expect(await docsOwnerConfigResolve({ environment, cwd: "/projects", read: async () => text })).toMatchObject({ success: false })
    }
  })

  test.each([
    ["/projects/x", "/projects/x", "leo"],
    ["/projectsX", "/projectsX", undefined],
    ["/home/david/adaptive/x", "/home/david/adaptive/x", "leo"],
    ["/projects/special/x", "/projects/special/x", "special"],
    ["/link/x", "/projects/x", "leo"],
  ])("matches cwd %s with realpath %s", async (cwd, physical, owner) => {
    expect(await docsOwnerConfigResolve({ environment, cwd, read, realpath: async () => physical })).toMatchObject({ success: true, data: owner })
  })

  test.each([
    ["/projects/x", [], "leo"],
    ["/elsewhere", [], "david"],
    ["/projects/x", ["--owner", "override"], "override"],
  ])("publishes from %s to selected owner", async (cwd, extra, owner) => {
    const requests: string[] = []
    const exit = await projectRegistryCliRun(["docs", "README.md", ...extra], {
      environment, docsCwd: () => cwd, docsConfigRead: read, docsRealpath: async (path) => path,
      requestFetch: async (input) => { requests.push(new URL(String(input)).pathname); return Response.json({ success: true, data: { urls: [], indexUrls: [] } }) },
      stdout: () => undefined,
    })
    expect(exit).toBe(0)
    expect(requests).toEqual([`/api/v1/users/${owner}/docs/publications`])
  })

  test("invalid config prevents publishing but does not affect unrelated commands", async () => {
    let requests = 0
    const options = { environment, docsConfigRead: async () => "{", requestFetch: async () => { requests++; return Response.json({ success: true, data: [] }) }, stdout: () => undefined, stderr: () => undefined }
    expect(await projectRegistryCliRun(["docs", "README.md"], options)).toBe(1)
    expect(requests).toBe(0)
    await projectRegistryCliRun(["project", "list"], options)
    expect(requests).toBe(1)
  })
})
