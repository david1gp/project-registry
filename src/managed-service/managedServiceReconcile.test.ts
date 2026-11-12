import { describe, expect, test } from "bun:test"
import {
  managedServiceConfigFixture,
  managedServiceFilesystemFake,
  managedServiceProjectFilesystemFake,
  managedServiceProjectFixture,
  managedServiceRunnerFake,
  type RunnerCall,
} from "../../test/fixtures/managedServiceFixtures.js"
import { managedServiceReconcile } from "./managedServiceReconcile.js"
import { managedServiceUnitMarker } from "./managedServiceUnitMarker.js"

const unitDirectory = managedServiceConfigFixture.unitDirectory
const archiveUnit = `${unitDirectory}/proj-archive-web.service`
const projectFilesystem = managedServiceProjectFilesystemFake({
  archive: { packageJson: { scripts: { dev: "vite --port 3000" } }, files: ["node_modules/.bin/vite"] },
  blog: { packageJson: { scripts: { dev: "clear && nice rsbuild dev" } } },
})
const archive = managedServiceProjectFixture("leo", "archive", [
  { id: "web", port: 4310, service: { autostart: true } },
])

function systemctlCalls(calls: RunnerCall[]): string[] {
  return calls.map((call) => `${call.command} ${call.args.join(" ")}`)
}

describe("managedServiceReconcile", () => {
  test("disabled config never touches the filesystem or systemd", async () => {
    const calls: RunnerCall[] = []
    const filesystem = managedServiceFilesystemFake({
      [`${unitDirectory}/proj-old-web.service`]: managedServiceUnitMarker,
    })
    const result = await managedServiceReconcile({
      config: { ...managedServiceConfigFixture, enabled: false },
      projects: [archive],
      runner: managedServiceRunnerFake(calls),
      filesystem,
      projectFilesystem,
    })
    expect(result.success).toBe(true)
    expect(filesystem.writes).toEqual([])
    expect(filesystem.removals).toEqual([])
    expect(calls).toEqual([])
  })

  test("writes a new unit with the derived command on the row port, reloads, enables, and starts it", async () => {
    const calls: RunnerCall[] = []
    const filesystem = managedServiceFilesystemFake()
    const result = await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [archive],
      runner: managedServiceRunnerFake(calls),
      filesystem,
      projectFilesystem,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.written).toEqual(["proj-archive-web.service"])
    expect(result.data.failures).toEqual([])
    expect(filesystem.files.get(archiveUnit)).toContain(
      "ExecStart=/projects/archive/node_modules/.bin/vite --port 4310 --strictPort --host 127.0.0.1",
    )
    expect(systemctlCalls(calls)).toEqual([
      "systemctl daemon-reload",
      "systemctl enable proj-archive-web.service",
      "systemctl restart proj-archive-web.service",
    ])
  })

  test("an unchanged unit is left alone after mutations but started at daemon startup", async () => {
    const filesystem = managedServiceFilesystemFake()
    const options = { config: managedServiceConfigFixture, projects: [archive], filesystem, projectFilesystem }
    await managedServiceReconcile({ ...options, runner: managedServiceRunnerFake([]) })

    const mutationCalls: RunnerCall[] = []
    await managedServiceReconcile({ ...options, runner: managedServiceRunnerFake(mutationCalls) })
    expect(mutationCalls).toEqual([])
    expect(filesystem.writes).toHaveLength(1)

    const startupCalls: RunnerCall[] = []
    await managedServiceReconcile({ ...options, runner: managedServiceRunnerFake(startupCalls), startup: true })
    expect(systemctlCalls(startupCalls)).toEqual([
      "systemctl enable proj-archive-web.service",
      "systemctl start proj-archive-web.service",
    ])
  })

  test("a changed non-autostart definition is disabled but never stopped", async () => {
    const calls: RunnerCall[] = []
    const manual = managedServiceProjectFixture("leo", "archive", [
      { id: "web", port: 4310, service: { autostart: false, command: "bun run start --port {port}" } },
    ])
    await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [manual],
      runner: managedServiceRunnerFake(calls),
      filesystem: managedServiceFilesystemFake(),
      projectFilesystem,
    })
    expect(systemctlCalls(calls)).toEqual(["systemctl daemon-reload", "systemctl disable proj-archive-web.service"])
  })

  test("removes only marker-bearing units whose row disappeared", async () => {
    const calls: RunnerCall[] = []
    const stale = `${unitDirectory}/proj-gone-web.service`
    const handWritten = `${unitDirectory}/proj-handmade-web.service`
    const filesystem = managedServiceFilesystemFake({
      [stale]: `${managedServiceUnitMarker}\n[Service]\n`,
      [handWritten]: "[Service]\nExecStart=/bin/true\n",
      [`${unitDirectory}/caddy.service`]: `${managedServiceUnitMarker}\n`,
    })
    const result = await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [],
      runner: managedServiceRunnerFake(calls),
      filesystem,
      projectFilesystem,
    })
    expect(result.success && result.data.removed).toEqual(["proj-gone-web.service"])
    expect(filesystem.removals).toEqual([stale])
    expect(filesystem.files.has(handWritten)).toBe(true)
    expect(systemctlCalls(calls)).toEqual(["systemctl disable --now proj-gone-web.service", "systemctl daemon-reload"])
  })

  test("never overwrites an unmanaged unit that has the managed name", async () => {
    const filesystem = managedServiceFilesystemFake({ [archiveUnit]: "[Service]\nExecStart=/bin/true\n" })
    const result = await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [archive],
      runner: managedServiceRunnerFake([]),
      filesystem,
      projectFilesystem,
    })
    expect(filesystem.writes).toEqual([])
    expect(result.success && result.data.failures).toEqual([
      "proj-archive-web.service: an unmanaged unit with this name exists",
    ])
  })

  test("a row that fails to resolve keeps its existing unit instead of deleting it", async () => {
    const existing = `${managedServiceUnitMarker}\nold\n`
    const filesystem = managedServiceFilesystemFake({ [`${unitDirectory}/proj-missing-web.service`]: existing })
    const missing = managedServiceProjectFixture("leo", "missing", [
      { id: "web", port: 4320, service: { autostart: true } },
    ])
    const result = await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [missing],
      runner: managedServiceRunnerFake([]),
      filesystem,
      projectFilesystem,
    })
    expect(filesystem.removals).toEqual([])
    expect(result.success && result.data.failures[0]).toStartWith("proj-missing-web.service:")
  })

  test("two owners claiming the same unit name both stay unrendered and are reported", async () => {
    const filesystem = managedServiceFilesystemFake()
    const result = await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [
        archive,
        managedServiceProjectFixture("tim", "archive", [{ id: "web", port: 4311, service: { autostart: true } }]),
      ],
      runner: managedServiceRunnerFake([]),
      filesystem,
      projectFilesystem,
    })
    expect(filesystem.writes).toEqual([])
    expect(result.success && result.data.failures).toEqual(["proj-archive-web.service: claimed by more than one owner"])
  })

  test("shell-chain dev scripts fall back to bun run dev with PORT/HOST env, like dev up", async () => {
    const filesystem = managedServiceFilesystemFake()
    await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [
        managedServiceProjectFixture("tim", "blog", [{ id: "web", port: 4400, service: { autostart: true } }]),
      ],
      runner: managedServiceRunnerFake([]),
      filesystem,
      projectFilesystem,
    })
    const unit = filesystem.files.get(`${unitDirectory}/proj-blog-web.service`) ?? ""
    expect(unit).toContain("ExecStart=/usr/bin/env bun run dev")
    expect(unit).toContain("Environment=PORT=4400")
  })

  test("refuses env files that symlink out of the project directory", async () => {
    const linked = managedServiceProjectFilesystemFake({
      archive: { packageJson: { scripts: { dev: "vite" } }, symlinks: { ".env": "/home/leo/.secrets" } },
    })
    const filesystem = managedServiceFilesystemFake()
    const result = await managedServiceReconcile({
      config: managedServiceConfigFixture,
      projects: [
        managedServiceProjectFixture("leo", "archive", [
          { id: "web", port: 4310, service: { autostart: true, envFile: ".env", command: "bun run start" } },
        ]),
      ],
      runner: managedServiceRunnerFake([]),
      filesystem,
      projectFilesystem: linked,
    })
    expect(filesystem.writes).toEqual([])
    expect(result.success && result.data.failures).toEqual([
      "proj-archive-web.service: service env file must not be a symlink",
    ])
  })
})
