import { describe, expect, test } from "bun:test"
import { devScriptCommandDerive } from "./devScriptCommandDerive.js"

function derive(scripts: Record<string, string>) {
  return devScriptCommandDerive({ scripts, port: 4400, host: "127.0.0.1" })
}

const viteTail = ["--port", "4400", "--strictPort", "--host", "127.0.0.1"]

describe("devScriptCommandDerive", () => {
  // Real-world `dev` scripts from /projects on wonder1-server.
  test.each([
    ["bun --bun vite dev", { command: "bun", args: ["--bun", "vite", "dev", ...viteTail] }],
    [
      "bun --env-file=.env.development --bun vite dev",
      { command: "bun", args: ["--env-file=.env.development", "--bun", "vite", "dev", ...viteTail] },
    ],
    [
      "bun --bun ./node_modules/vite/bin/vite.js dev --configLoader native",
      {
        command: "bun",
        args: ["--bun", "./node_modules/vite/bin/vite.js", "dev", "--configLoader", "native", ...viteTail],
      },
    ],
    [
      "vite --mode development --host 0.0.0.0 --port 3120 --strictPort",
      { command: "node_modules/.bin/vite", args: ["--mode", "development", ...viteTail], projectRelativeCommand: true },
    ],
    [
      "vite --port 5174 --strictPort",
      { command: "node_modules/.bin/vite", args: viteTail, projectRelativeCommand: true },
    ],
    ["vite --host", { command: "node_modules/.bin/vite", args: viteTail, projectRelativeCommand: true }],
    ["vite dev", { command: "node_modules/.bin/vite", args: ["dev", ...viteTail], projectRelativeCommand: true }],
    ["bunx --bun vite --port=3000", { command: "bunx", args: ["--bun", "vite", ...viteTail] }],
    [
      "rsbuild dev --host 127.0.0.1",
      {
        command: "node_modules/.bin/rsbuild",
        args: ["dev", "--port", "4400", "--host", "127.0.0.1"],
        projectRelativeCommand: true,
      },
    ],
    [
      "next dev -p 3000",
      {
        command: "node_modules/.bin/next",
        args: ["dev", "--port", "4400", "--hostname", "127.0.0.1"],
        projectRelativeCommand: true,
      },
    ],
    [
      "next dev --turbopack -H 0.0.0.0 --port=3001",
      {
        command: "node_modules/.bin/next",
        args: ["dev", "--turbopack", "--port", "4400", "--hostname", "127.0.0.1"],
        projectRelativeCommand: true,
      },
    ],
    ["bunx astro dev", { command: "bunx", args: ["astro", "dev", "--port", "4400", "--host", "127.0.0.1"] }],
  ])("%s", (script, expected) => {
    expect(derive({ dev: script })).toEqual(expected)
  })

  test("follows bun run indirection to the referenced script", () => {
    expect(derive({ dev: "bun run vite:dev", "vite:dev": "vite --host" })).toEqual({
      command: "node_modules/.bin/vite",
      args: viteTail,
      projectRelativeCommand: true,
    })
    expect(derive({ dev: "bun run rsbuild:dev", "rsbuild:dev": "bun run rsbuild dev" })).toEqual({
      command: "bun",
      args: ["run", "rsbuild", "dev", "--port", "4400", "--host", "127.0.0.1"],
    })
  })

  test("falls back for anything that is not one dev-tool invocation", () => {
    const fallbacks: Record<string, string>[] = [
      { dev: "bun run frontend:build:development && bun run serve" },
      { dev: "clear && nice -5 vite dev --debug hmr" },
      { dev: "bun --watch src/server.ts" },
      { dev: "bun run api", api: "bun ./api.ts" },
      { dev: "bun run missing" },
      { dev: "vite build" },
      { dev: "next start" },
      { dev: "NODE_ENV=development vite" },
      { dev: "vite --port $PORT" },
      { dev: "vite --port" },
      { dev: "next dev -H" },
      { dev: "bun run loop", loop: "bun run dev" },
      { dev: "bun --bun ../evil/node_modules/vite/bin/vite.js" },
      { dev: "bun run toString" },
    ]
    for (const scripts of fallbacks) {
      expect(derive(scripts)).toBeUndefined()
    }
  })
})
