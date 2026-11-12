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

  test("a row dev.command beats the package.json dev script with substituted placeholders", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate(manifestWith({ dev: "vite --port 9999" })),
      rowCommand: "bun run vite --host {host} --port {port} --strictPort",
      port: 4400,
      host: "127.0.0.1",
    })

    expect(result).toEqual({
      success: true,
      data: {
        command: "bun",
        args: ["run", "vite", "--host", "127.0.0.1", "--port", "4400", "--strictPort"],
      },
    })
  })

  test("a row dev.command without placeholders needs no port or host", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate({}),
      rowCommand: "bun run ./server.ts",
    })

    expect(result).toEqual({ success: true, data: { command: "bun", args: ["run", "./server.ts"] } })
  })

  test("a row dev.command works when the manifest is missing", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate({}),
      rowCommand: "bun run dev",
    })

    expect(result).toEqual({ success: true, data: { command: "bun", args: ["run", "dev"] } })
  })

  test("an invalid row dev.command fails instead of falling back", async () => {
    for (const rowCommand of ["bun run dev && evil", "/usr/bin/vite dev", "bun run vite --port {nope}", "   "]) {
      const result = await devCommandResolve({
        directory: "/projects/akademie",
        projectsRoot: "/projects",
        filesystem: filesystemCreate(manifestWith({ dev: "vite" })),
        rowCommand,
        port: 4400,
        host: "127.0.0.1",
      })
      expect(result.success).toBe(false)
    }
  })

  test("row placeholders without a port or host fail loudly", async () => {
    const noPort = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate({}),
      rowCommand: "bun run vite --port {port}",
      host: "127.0.0.1",
    })
    expect(noPort.success).toBe(false)
    if (!noPort.success) expect(noPort.errorMessage).toBe("dev command placeholders need a port")

    const noHost = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate({}),
      rowCommand: "bun run vite --host {host}",
      port: 4400,
    })
    expect(noHost.success).toBe(false)
    if (!noHost.success) expect(noHost.errorMessage).toBe("dev command placeholders need a host")
  })

  test("neither row nor manifest names the missing contract for the project", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate(manifestWith({})),
      project: "tim/akademie",
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("request.invalid")
    expect(result.errorMessage).toBe(
      "dev command for project tim/akademie is not configured (dev package.json has no dev script)",
    )
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
  test("runs a derived bare tool from the project's own node_modules on the lease port", async () => {
    const manifests = manifestWith({ dev: "bun run vite:dev", "vite:dev": "vite --host --port 3007" })
    const options = { directory: "/projects/akademie", projectsRoot: "/projects", port: 4401, host: "127.0.0.1" }
    const installed = await devCommandResolve({ ...options, filesystem: filesystemCreate(manifests) })
    expect(installed).toEqual({
      success: true,
      data: {
        command: "/projects/akademie/node_modules/.bin/vite",
        args: ["--port", "4401", "--strictPort", "--host", "127.0.0.1"],
      },
    })

    // Missing bin, or a bin symlinked out of the projects root: package-manager fallback.
    const missing: DevProjectFilesystem = {
      ...filesystemCreate(manifests),
      realpath: async (path) => {
        if (path.includes("node_modules")) throw new Error("ENOENT")
        return path
      },
    }
    const escaped = filesystemCreate(manifests, { "/projects/akademie/node_modules/.bin/vite": "/tmp/evil/vite" })
    for (const filesystem of [missing, escaped]) {
      const result = await devCommandResolve({ ...options, filesystem })
      expect(result).toEqual({ success: true, data: { command: "bun", args: ["run", "dev"] } })
    }
  })

  test("a launcher-prefixed tool runs through bun without a filesystem lookup", async () => {
    const result = await devCommandResolve({
      directory: "/projects/akademie",
      projectsRoot: "/projects",
      filesystem: filesystemCreate(manifestWith({ dev: "bun --bun vite dev" })),
      port: 4401,
      host: "127.0.0.1",
    })
    expect(result).toEqual({
      success: true,
      data: { command: "bun", args: ["--bun", "vite", "dev", "--port", "4401", "--strictPort", "--host", "127.0.0.1"] },
    })
  })
})
