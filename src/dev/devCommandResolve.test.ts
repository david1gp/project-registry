import { describe, expect, test } from "bun:test"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import { devCommandResolve } from "./devCommandResolve.js"

function filesystemCreate(
  manifests: Record<string, string>,
  realpaths: Record<string, string> = {},
): DevProjectFilesystem {
  return {
    readFile: async (path) => {
      const manifest = manifests[path]
      if (manifest === undefined) throw new Error(`ENOENT: ${path}`)
      return manifest
    },
    realpath: async (path) => realpaths[path] ?? path,
    stat: async () => ({ isDirectory: () => true }),
  }
}

const manifestPath = "/projects/akademie/package.json"

function manifestWith(scripts: unknown): Record<string, string> {
  return { [manifestPath]: JSON.stringify({ name: "akademie", scripts }) }
}

describe("devCommandResolve", () => {
  test("resolves the package-manager dev runner for a valid dev script", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate(manifestWith({ dev: "vite --port 5173" })),
    })

    // The script body is validated but never interpreted: it runs through the
    // package manager so quoting and chaining cannot escape the argv boundary.
    expect(result).toEqual({ success: true, data: { command: "bun", args: ["run", "dev"] } })
  })

  test("passes a D3 registry command override through ahead of the fallback", async () => {
    const filesystem = filesystemCreate({})
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem,
      override: { command: "node", args: ["./server.mjs"] },
    })

    expect(result).toEqual({ success: true, data: { command: "node", args: ["./server.mjs"] } })
  })

  test("reports a missing dev script as a request error", async () => {
    for (const scripts of [{}, { dev: "" }, { dev: "   " }, { test: "bun test" }, undefined]) {
      const result = await devCommandResolve({
        directory: "/projects/akademie",
        projectsRoot: "/projects",
        filesystem: filesystemCreate(scripts === undefined ? {} : manifestWith(scripts)),
      })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.code).toBe("request.invalid")
      expect(result.errorMessage).toBe(
        scripts === undefined ? "dev package.json is missing" : "dev package.json has no dev script",
      )
    }
  })

  test("reports an invalid package.json as a request error", async () => {
    for (const body of ["{not json", JSON.stringify({ scripts: { dev: 42 } }), JSON.stringify(["dev"])] as const) {
      const result = await devCommandResolve({
        directory: "/projects/akademie",
        projectsRoot: "/projects",
        filesystem: filesystemCreate({ [manifestPath]: body }),
      })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.code).toBe("request.invalid")
    }
  })

  test("rejects a manifest symlink escape outside the projects root", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate(manifestWith({ dev: "vite" }), { [manifestPath]: "/home/tim/evil/package.json" }),
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("dev package.json escapes its projects root")
  })

  test("ignores unrelated manifest keys and non-string dev scripts", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate({
        [manifestPath]: JSON.stringify({
          name: "akademie",
          version: "1.0.0",
          dependencies: { vite: "^6" },
          scripts: { dev: "astro dev", build: "astro build" },
        }),
      }),
    })

    expect(result).toEqual({ success: true, data: { command: "bun", args: ["run", "dev"] } })
  })
})
