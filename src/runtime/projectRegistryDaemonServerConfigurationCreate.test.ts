import { describe, expect, test } from "bun:test"
import { projectRegistryDaemonServerConfigurationCreate } from "./projectRegistryDaemonServerConfigurationCreate.js"

describe("projectRegistryDaemonServerConfigurationCreate", () => {
  test.each([
    { name: "Unix", listener: { unix: "/run/project-registry/leo.sock" } },
    { name: "HTTP", listener: { hostname: "127.0.0.1", port: 3000 } },
  ])("disables the $name idle timeout only for an ACL repair POST", async ({ listener }) => {
    const calls: Array<{ request: Request; seconds: number }> = []
    const handled: Request[] = []
    const fetch = (request: Request) => {
      handled.push(request)
      return new Response("ok")
    }
    const options = projectRegistryDaemonServerConfigurationCreate({ ...listener, fetch })
    const handle = options.fetch as (request: Request, server: { timeout: typeof timeout }) => Response
    const timeout = (request: Request, seconds: number) => calls.push({ request, seconds })
    const repair = new Request("http://localhost/api/v1/users/leo/projects/demos/fix-acl", { method: "POST" })
    const missing = new Request("http://localhost/api/v1/users/leo/projects/missing/fix-acl", { method: "POST" })
    const read = new Request("http://localhost/api/v1/users/leo/projects/demos/fix-acl")
    const unrelated = new Request("http://localhost/api/v1/users/leo/projects/demos/access-logs", { method: "POST" })

    expect(await handle(repair, { timeout }).text()).toBe("ok")
    handle(missing, { timeout })
    handle(read, { timeout })
    handle(unrelated, { timeout })

    expect(calls).toEqual([
      { request: repair, seconds: 0 },
      { request: missing, seconds: 0 },
    ])
    expect(handled).toEqual([repair, missing, read, unrelated])
    expect(options).toMatchObject(listener)
  })
})
