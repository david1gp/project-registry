import { describe, expect, test } from "bun:test"
import type { ProjectRegistryDaemonCloudflareCredentialsFilesystem } from "./ProjectRegistryDaemonCloudflareCredentialsFilesystem.js"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"
import { projectRegistryDaemonPrivateDnsCredentialsCreate } from "./projectRegistryDaemonPrivateDnsCredentialsCreate.js"

function filesystemCreate(files: Map<string, string>): ProjectRegistryDaemonCloudflareCredentialsFilesystem {
  const stat = (path: string): ProjectRegistryDaemonFileStat | undefined => {
    if (path === "/etc/project-registry/tailscale") return { type: "directory", mode: 0o700, uid: 0, gid: 0 }
    if (files.has(path)) return { type: "file", mode: 0o600, uid: 0, gid: 0 }
    return undefined
  }
  return {
    lstat: async (path) => stat(path),
    realpath: async (path) => path,
    readFile: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return value
    },
  }
}

describe("projectRegistryDaemonPrivateDnsCredentialsCreate", () => {
  test("resolves the tailnet-wide token and hot-reloads", async () => {
    const files = new Map([["/etc/project-registry/tailscale/tailscale.env", "TAILSCALE_API_KEY=tskey-first\n"]])
    const credentialsR = projectRegistryDaemonPrivateDnsCredentialsCreate({
      directory: "/etc/project-registry/tailscale",
      filesystem: filesystemCreate(files),
    })
    expect(credentialsR.success).toBe(true)
    if (!credentialsR.success) return
    await expect(credentialsR.data.tokenResolve()).resolves.toEqual({ success: true, data: "tskey-first" })
    files.set("/etc/project-registry/tailscale/tailscale.env", "TAILSCALE_ACCESS_TOKEN=tskey-second\n")
    await expect(credentialsR.data.tokenResolve()).resolves.toEqual({ success: true, data: "tskey-second" })
  })

  test("prefers TAILSCALE_API_KEY and returns undefined when missing", async () => {
    const both = new Map([
      [
        "/etc/project-registry/tailscale/tailscale.env",
        "TAILSCALE_ACCESS_TOKEN=tskey-alias\nTAILSCALE_API_KEY=tskey-preferred\n",
      ],
    ])
    const credentialsR = projectRegistryDaemonPrivateDnsCredentialsCreate({
      directory: "/etc/project-registry/tailscale",
      filesystem: filesystemCreate(both),
    })
    if (!credentialsR.success) throw new Error("setup failed")
    await expect(credentialsR.data.tokenResolve()).resolves.toEqual({ success: true, data: "tskey-preferred" })

    const missingR = projectRegistryDaemonPrivateDnsCredentialsCreate({
      directory: "/etc/project-registry/tailscale",
      filesystem: filesystemCreate(new Map()),
    })
    if (!missingR.success) throw new Error("setup failed")
    await expect(missingR.data.tokenResolve()).resolves.toEqual({ success: true, data: undefined })
  })

  test("rejects invalid directories without reading", async () => {
    let reads = 0
    const filesystem = filesystemCreate(new Map())
    const counting: ProjectRegistryDaemonCloudflareCredentialsFilesystem = {
      ...filesystem,
      readFile: async (path) => {
        reads += 1
        return filesystem.readFile(path)
      },
    }
    expect(
      projectRegistryDaemonPrivateDnsCredentialsCreate({ directory: "relative/path", filesystem: counting }).success,
    ).toBe(false)
    expect(reads).toBe(0)
  })
})
