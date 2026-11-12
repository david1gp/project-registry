import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import {
  managedServiceConfigFixture,
  managedServiceFilesystemFake,
  managedServiceProjectFilesystemFake,
  managedServiceProjectFixture,
  managedServiceRunnerFake,
  type RunnerCall,
} from "../../test/fixtures/managedServiceFixtures.js"
import type { Actor } from "../access/Actor.js"
import type { Project } from "../project/Project.js"
import type { ManagedServiceConfig } from "./ManagedServiceConfig.js"
import { managedServicesCreate } from "./managedServicesCreate.js"

const projects: Project[] = [
  managedServiceProjectFixture("leo", "archive", [
    { id: "web", port: 4310, service: { autostart: true, command: "bun run start --port {port}" } },
    { id: "api", port: 4311, service: { autostart: false, command: "bun run api --port {port}" } },
  ]),
  managedServiceProjectFixture("leo", "plain", [{ id: "web", port: 4320 }]),
]
const projectFilesystem = managedServiceProjectFilesystemFake({ archive: {}, plain: {} })

function actor(username: string): Actor {
  return { subject: null, username, role: "own" }
}

function servicesCreate(config: ManagedServiceConfig = managedServiceConfigFixture) {
  const calls: RunnerCall[] = []
  const filesystem = managedServiceFilesystemFake()
  const streamed: string[][] = []
  const services = managedServicesCreate({
    config,
    projectsRead: async () => createResult(projects),
    runner: managedServiceRunnerFake(calls, (call) =>
      call.args[0] === "show"
        ? { exitCode: 0, stdout: "ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\n" }
        : { exitCode: 0 },
    ),
    filesystem,
    projectFilesystem,
    logStreamer: (args) => {
      streamed.push([...args])
      return { stdout: new Response("log line\n").body!, cancel: () => {} }
    },
    clock: () => Date.UTC(2026, 10, 12),
  })
  return { services, calls, filesystem, streamed }
}

describe("managedServicesCreate", () => {
  test("disabled services refuse every verb without touching systemd or disk", async () => {
    const { services, calls, filesystem } = servicesCreate({ ...managedServiceConfigFixture, enabled: false })
    expect((await services.status(actor("leo"), { project: "archive" })).success).toBe(false)
    expect((await services.act(actor("leo"), "restart", { project: "archive", service: "web" })).success).toBe(false)
    expect((await services.reconcile()).success).toBe(false)
    expect(calls).toEqual([])
    expect(filesystem.files.size).toBe(0)
  })

  test("allowed operators act on any owner's managed service; others are forbidden", async () => {
    const { services } = servicesCreate()
    // tim does not own leo/archive but is an allowed operator.
    expect((await services.status(actor("tim"), { project: "archive" })).success).toBe(true)
    const forbidden = await services.status(actor("caddy"), { project: "archive" })
    expect(forbidden.success === false && forbidden.code).toBe("services.forbidden")
  })

  test("projects without a managed definition are not found", async () => {
    const { services } = servicesCreate()
    const result = await services.status(actor("leo"), { project: "plain" })
    expect(result.success === false && result.code).toBe("services.not-found")
  })

  test("actions on a multi-service project require --service", async () => {
    const { services, calls } = servicesCreate()
    const result = await services.act(actor("leo"), "restart", { project: "archive" })
    expect(result.success === false && result.code).toBe("projects.conflict")
    expect(calls).toEqual([])
  })

  test("an action renders the unit first, runs systemctl, and appends an audit record", async () => {
    const { services, calls, filesystem } = servicesCreate()
    const result = await services.act(actor("mit"), "start", { project: "archive", service: "api" })
    expect(result.success && result.data).toMatchObject({ unit: "proj-archive-api.service", activeState: "active" })
    expect(calls.map((call) => call.args.join(" "))).toContain("start proj-archive-api.service")
    expect(filesystem.files.has("/etc/systemd/system/proj-archive-api.service")).toBe(true)
    const audit = filesystem.files.get(managedServiceConfigFixture.auditLogPath) ?? ""
    expect(JSON.parse(audit.trim())).toEqual({
      at: "2026-11-12T00:00:00.000Z",
      actor: "mit",
      action: "start",
      owner: "leo",
      project: "archive",
      service: "api",
      unit: "proj-archive-api.service",
      success: true,
    })
  })

  test("logs stream journalctl for the selected unit with a bounded line count", async () => {
    const { services, streamed } = servicesCreate()
    const result = await services.logs(actor("david"), { project: "archive", service: "web" }, 50_000, true)
    expect(result.success).toBe(true)
    expect(streamed).toEqual([
      ["--unit", "proj-archive-web.service", "--lines", "10000", "--no-pager", "--output", "short-iso", "--follow"],
    ])
  })
})
