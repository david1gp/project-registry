import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { projectCanonicalNormalize } from "./projectCanonicalNormalize.js"
import { projectCanonicalSchema } from "./projectCanonicalSchema.js"
import { projectServiceDevSchema } from "./projectServiceDevSchema.js"

describe("projectServiceDevSchema", () => {
  test("accepts a valid dev command", async () => {
    const parsed = a.safeParse(projectServiceDevSchema, {
      command: "bun run vite --host {host} --port {port} --strictPort",
    })
    expect(parsed.success).toBe(true)
  })

  test("a service row without dev parses with no dev key", async () => {
    const parsed = a.safeParse(projectCanonicalSchema, {
      schemaVersion: 2,
      owner: "tim",
      name: "akademie",
      services: [{ id: "web", units: [], caddy: null, ownership: "registry" }],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect("dev" in parsed.output.services[0]!).toBe(false)
  })

  test("rejects blank, shell, and escaping dev commands", async () => {
    for (const command of ["   ", "bun run dev && evil", "bun run vite --port {nope}", "/usr/bin/vite dev"]) {
      expect(a.safeParse(projectServiceDevSchema, { command }).success).toBe(false)
    }
  })

  test("normalize preserves dev while old rows parse unchanged", async () => {
    const preserved = projectCanonicalNormalize({
      schemaVersion: 2,
      owner: "tim",
      name: "akademie",
      services: [
        {
          id: "web",
          units: [],
          caddy: null,
          ownership: "registry",
          dev: { command: "bun run vite --port {port}" },
        },
      ],
    })
    expect(preserved.success).toBe(true)
    if (!preserved.success) return
    expect(preserved.data.services[0]!.dev).toEqual({ command: "bun run vite --port {port}" })

    const legacy = projectCanonicalNormalize({
      schemaVersion: 2,
      owner: "tim",
      name: "werkstatt",
      services: [{ id: "web", units: [], caddy: null, ownership: "registry" }],
    })
    expect(legacy.success).toBe(true)
    if (!legacy.success) return
    expect("dev" in legacy.data.services[0]!).toBe(false)
  })
})
