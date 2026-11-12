import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { projectCanonicalSchema } from "./projectCanonicalSchema.js"
import { projectServiceManagedSchema } from "./projectServiceManagedSchema.js"

describe("projectServiceManagedSchema", () => {
  test("accepts a minimal definition (command derived later) and a full one", () => {
    expect(a.safeParse(projectServiceManagedSchema, { autostart: true }).success).toBe(true)
    expect(
      a.safeParse(projectServiceManagedSchema, {
        command: "bun run start --port {port} --host {host}",
        envFile: "config/.env.production",
        autostart: false,
      }).success,
    ).toBe(true)
  })

  test("requires an explicit autostart decision", () => {
    expect(a.safeParse(projectServiceManagedSchema, { command: "bun run start" }).success).toBe(false)
  })

  test("rejects shell-shaped or escaping commands with the dev command grammar", () => {
    for (const command of ["bun run start && evil", "/usr/bin/node server.js", "../bin/serve", "vite --port {nope}"]) {
      expect(a.safeParse(projectServiceManagedSchema, { command, autostart: true }).success).toBe(false)
    }
  })

  test("rejects env files outside the project directory", () => {
    for (const envFile of ["/etc/shadow", "../other/.env", "a/../../.env", "./.env", "a//b", ".env;rm", ""]) {
      expect(a.safeParse(projectServiceManagedSchema, { envFile, autostart: true }).success).toBe(false)
    }
  })

  test("a canonical row carries the service definition next to caddy and dev", () => {
    const parsed = a.safeParse(projectCanonicalSchema, {
      schemaVersion: 2,
      owner: "leo",
      name: "archive",
      services: [
        {
          id: "web",
          units: [],
          caddy: { port: 4310, domains: ["archive.wonder1.de"] },
          dev: { command: "vite --port {port}" },
          service: { autostart: true, envFile: ".env" },
        },
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.output.services[0]!.service).toEqual({ autostart: true, envFile: ".env" })
  })
})
