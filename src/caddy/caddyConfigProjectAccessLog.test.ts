import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import { projectAccessLogId } from "../access-log/projectAccessLogId.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import { caddyConfigValidate } from "./caddyConfigValidate.js"

const productionCaddyBinary = "/home/caddy/.local/bin/caddy"
const caddyBinary =
  Bun.which("caddy") ?? ((await Bun.file(productionCaddyBinary).exists()) ? productionCaddyBinary : null)

function accessLogConfig(projects: unknown[], root = "/var/lib/project-registry/caddy-access-logs") {
  const result = caddyConfigGenerate(projects, { caddyAccessLogRoot: root })
  expect(result.success).toBe(true)
  if (!result.success) return undefined
  return result.data
}

describe("Caddy project access logging", () => {
  test("snapshots active logger, all-domain mapping, privacy, rotation, and default exclusion", () => {
    const config = accessLogConfig([
      caddyConfigGenerateFixtures.disabled,
      caddyConfigGenerateFixtures.catalogOnly,
      caddyConfigGenerateFixtures.proxy,
    ])
    expect(config).toBeDefined()
    if (config === undefined) return

    const loggerId = projectAccessLogId(caddyConfigGenerateFixtures.proxy)
    expect(config.logging?.logs[loggerId]).toMatchObject({ writer: { mode: "0600", dir_mode: "0700" } })

    expect({
      logging: config.logging,
      serverLogs: config.apps.http.servers.srv0.logs,
    }).toMatchSnapshot()
  })

  test("omits all access logging configuration when the root is unset", () => {
    const withoutRoot = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy])
    const withEmptyOptions = caddyConfigGenerate([caddyConfigGenerateFixtures.proxy], {})

    expect(withoutRoot).toEqual(withEmptyOptions)
    expect(withoutRoot.success).toBe(true)
    if (!withoutRoot.success) return
    expect(withoutRoot.data.logging).toBeUndefined()
    expect(withoutRoot.data.apps.http.servers.srv0.logs).toBeUndefined()
  })

  test("does not create loggers for disabled or catalog-only projects", () => {
    const config = accessLogConfig([caddyConfigGenerateFixtures.disabled, caddyConfigGenerateFixtures.catalogOnly])

    expect(config).toBeDefined()
    if (config === undefined) return
    expect(config.logging).toBeUndefined()
    expect(config.apps.http.servers.srv0.logs).toBeUndefined()
  })

  test("isolates distinct project keys and rejects colliding domains", () => {
    const left = {
      ...caddyConfigGenerateFixtures.proxy,
      owner: "owner-a",
      name: "project-b-c",
      caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["left.example"] },
    }
    const right = {
      ...caddyConfigGenerateFixtures.proxy,
      owner: "owner-a-project-b",
      name: "c",
      caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["right.example"] },
    }
    const isolated = accessLogConfig([left, right])
    expect(isolated).toBeDefined()
    if (isolated === undefined) return

    const leftId = projectAccessLogId(left)
    const rightId = projectAccessLogId(right)
    expect(leftId).not.toBe(rightId)
    expect(isolated.logging).toBeDefined()
    if (isolated.logging === undefined) return
    expect(isolated.logging.logs[leftId]).toBeDefined()
    expect(isolated.logging.logs[rightId]).toBeDefined()
    expect((isolated.logging.logs[leftId] as { writer: { filename: string } }).writer.filename).toBe(
      `/var/lib/project-registry/caddy-access-logs/projects/${leftId}/access.jsonl`,
    )
    expect((isolated.logging.logs[rightId] as { writer: { filename: string } }).writer.filename).toBe(
      `/var/lib/project-registry/caddy-access-logs/projects/${rightId}/access.jsonl`,
    )

    const collision = caddyConfigGenerate([left, { ...right, caddy: { ...right.caddy, domains: ["left.example"] } }], {
      caddyAccessLogRoot: "/var/lib/project-registry/caddy-access-logs",
    })
    expect(collision.success).toBe(false)
  })

  test.skipIf(caddyBinary === null)("passes native Caddy validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-caddy-validate-"))
    try {
      const config = accessLogConfig([caddyConfigGenerateFixtures.proxy], directory)
      expect(config).toBeDefined()
      if (config === undefined || caddyBinary === null) return

      expect(await caddyConfigValidate(config, { caddyBin: caddyBinary })).toEqual({ success: true, data: true })
      const projectDirectory = join(directory, "projects", projectAccessLogId(caddyConfigGenerateFixtures.proxy))
      expect((await stat(projectDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(projectDirectory, "access.jsonl"))).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
