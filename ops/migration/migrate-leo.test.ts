import { describe, expect, test } from "bun:test"
import { constants } from "node:fs"
import { access, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const migrationDirectory = import.meta.dir
const wrapper = join(migrationDirectory, "migrate-leo.bash")
const configuredCaddyBinary =
  Bun.env.PROJECT_REGISTRY_CADDY_BINARY ?? Bun.env.CADDY_BINARY ?? "/home/caddy/.local/bin/caddy"

type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

async function command(
  commandName: string,
  args: string[],
  environment: Record<string, string>,
): Promise<CommandResult> {
  const process = Bun.spawn([commandName, ...args], { env: environment, stderr: "pipe", stdout: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stderr, stdout }
}

async function fakeSystemd(directory: string): Promise<{ bin: string; environment: Record<string, string> }> {
  const bin = join(directory, "bin")
  await mkdir(bin, { recursive: true })
  const log = join(directory, "systemctl.log")
  const systemctl = join(bin, "systemctl")
  const id = join(bin, "id")

  await Bun.write(
    systemctl,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
if [ "$FAKE_SYSTEMCTL_FAIL_ON" = "$*" ]; then exit 23; fi
exit 0
`,
  )
  await Bun.write(
    id,
    `#!/bin/sh
if [ "$1" = "-u" ] && [ "$2" = "leo" ]; then printf '1000\\n'; exit 0; fi
if [ "$1" = "-u" ]; then printf '0\\n'; exit 0; fi
exec /usr/bin/id "$@"
`,
  )
  await chmod(systemctl, 0o755)
  await chmod(id, 0o755)

  return {
    bin,
    environment: {
      ...(Bun.env as Record<string, string>),
      FAKE_SYSTEMCTL_LOG: log,
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
    },
  }
}

async function fakeCaddy(fake: { bin: string; environment: Record<string, string> }): Promise<string> {
  const caddy = join(fake.bin, "caddy")
  await Bun.write(
    caddy,
    `#!/bin/sh
if [ "$1" = "validate" ] || [ "$1" = "reload" ]; then
  if [ "$4" != "--adapter" ] || [ -n "$5" ]; then exit 43; fi
fi
printf 'caddy' >> "$FAKE_SYSTEMCTL_LOG"
for argument in "$@"; do
  if [ -n "$argument" ]; then printf ' %s' "$argument" >> "$FAKE_SYSTEMCTL_LOG"; else printf ' <empty>' >> "$FAKE_SYSTEMCTL_LOG"; fi
done
printf '\\n' >> "$FAKE_SYSTEMCTL_LOG"
if [ "$FAKE_CADDY_FAIL_ON" = "$1" ]; then exit 42; fi
exit 0
`,
  )
  await chmod(caddy, 0o755)
  return caddy
}

async function logLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function expectNoCaddyServiceControl(calls: string[]): void {
  expect(
    calls.filter((call) => call.includes("caddy.service") || call.includes("--user") || call.includes("--machine")),
  ).toEqual([])
}

describe("Leo migration wrapper", () => {
  test("configured Caddy validates native JSON rollback config without live reload", async () => {
    if (!(await executable(configuredCaddyBinary))) return

    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-caddy-validation-"))
    try {
      const config = join(directory, "caddy-admin-config.json")
      await Bun.write(
        config,
        `${JSON.stringify({
          admin: { listen: "127.0.0.1:2019" },
          apps: { http: { servers: { rollback: { listen: [":443"], routes: [] } } } },
        })}\n`,
      )

      const result = await command(configuredCaddyBinary, ["validate", "--config", config, "--adapter", ""])

      expect(result.exitCode).toBe(0)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("defaults to a non-mutating cutover plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-dry-run-"))
    try {
      const fake = await fakeSystemd(directory)
      const result = await command(
        "bash",
        [wrapper, "cutover", "--systemctl-bin", join(fake.bin, "systemctl")],
        fake.environment,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("mode: dry-run")
      expect(result.stdout).toContain("would run:")
      expect(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
      ])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("cuts over in a fixed order with configured daemon names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-cutover-"))
    try {
      const fake = await fakeSystemd(directory)
      const options = [
        "--apply",
        "--systemctl-bin",
        join(fake.bin, "systemctl"),
        "--old-projects-service",
        "legacy-projects.service",
        "--new-daemon-service",
        "registry.service",
      ]
      const result = await command("bash", [wrapper, "cutover", ...options], fake.environment)

      expect(result.exitCode).toBe(0)
      expect(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)).toEqual([
        "cat legacy-projects.service",
        "cat registry.service",
        "stop legacy-projects.service",
        "disable legacy-projects.service",
        "daemon-reload",
        "enable registry.service",
        "start registry.service",
        "is-active --quiet registry.service",
      ])
      expectNoCaddyServiceControl(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG))
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("validates and reloads the saved config before resuming the legacy daemon", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-"))
    try {
      const fake = await fakeSystemd(directory)
      const caddy = await fakeCaddy(fake)
      const backup = join(directory, "caddy-state", "caddy-admin-config.json")
      const backupDropin = join(directory, "caddy-state", "caddy-umask-dropin.conf")
      const config = join(directory, "live", "caddy.json")
      const dropin = join(directory, "live", "caddy.service.d", "10-project-registry-umask.conf")
      await mkdir(join(directory, "caddy-state"), { recursive: true })
      await mkdir(join(directory, "live"), { recursive: true })
      await mkdir(join(directory, "live", "caddy.service.d"), { recursive: true })
      await Bun.write(backup, '{"legacy":true}\n')
      await Bun.write(backupDropin, "[Service]\nUMask=0022\n")
      await Bun.write(config, '{"candidate":true}\n')
      await Bun.write(dropin, "[Service]\nUMask=0077\n")
      const result = await command(
        "bash",
        [
          wrapper,
          "rollback",
          "--apply",
          "--systemctl-bin",
          join(fake.bin, "systemctl"),
          "--caddy-binary",
          caddy,
          "--caddy-config",
          config,
           "--caddy-backup",
           join(directory, "caddy-state"),
           "--caddy-umask-dropin",
           dropin,
        ],
        fake.environment,
      )

      expect(result.exitCode).toBe(0)
      expect(await readFile(dropin, "utf8")).toBe("[Service]\nUMask=0022\n")
      expect(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
        `caddy validate --config ${backup} --adapter <empty>`,
        "stop project-registryd.service",
        "disable project-registryd.service",
        `caddy reload --config ${backup} --adapter <empty> --address 127.0.0.1:2019`,
        "daemon-reload",
        "enable caddy-projects.service",
        "start caddy-projects.service",
        "is-active --quiet caddy-projects.service",
      ])
      expect(await readFile(config, "utf8")).toBe('{"legacy":true}\n')
      expect(result.stdout).toContain("rollback completed")
      expectNoCaddyServiceControl(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG))
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("normalizes every accepted loopback admin address for caddy reload", async () => {
    for (const adminAddress of ["127.0.0.1:2019", "http://127.0.0.1:2019", "https://127.0.0.1:2019"]) {
      const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-address-"))
      try {
        const fake = await fakeSystemd(directory)
        const caddy = await fakeCaddy(fake)
        const backup = join(directory, "legacy.json")
        const config = join(directory, "caddy.json")
        await Bun.write(backup, "{}\n")
        await Bun.write(config, '{"candidate":true}\n')
        const result = await command(
          "bash",
          [
            wrapper,
            "rollback",
            "--apply",
            "--systemctl-bin",
            join(fake.bin, "systemctl"),
            "--caddy-binary",
            caddy,
            "--caddy-config",
            config,
            "--caddy-backup",
            backup,
            "--caddy-admin-address",
            adminAddress,
          ],
          fake.environment,
        )

        expect(result.exitCode).toBe(0)
        expect(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)).toContain(
          `caddy reload --config ${backup} --adapter <empty> --address 127.0.0.1:2019`,
        )
      } finally {
        await rm(directory, { force: true, recursive: true })
      }
    }
  })

  test("rejects non-loopback admin addresses before any mutation", async () => {
    for (const adminAddress of [
      "127.0.0.2:2019",
      "127.0.0.1:2020",
      "http://127.0.0.1:2019/config/",
      "http://user:pass@127.0.0.1:2019",
      "http://127.0.0.1:2019?query=1",
      "http://127.0.0.1:2019#fragment",
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-invalid-address-"))
      try {
        const fake = await fakeSystemd(directory)
        const backup = join(directory, "legacy.json")
        const config = join(directory, "caddy.json")
        await Bun.write(backup, "{}\n")
        await Bun.write(config, '{"candidate":true}\n')
        const result = await command(
          "bash",
          [
            wrapper,
            "rollback",
            "--apply",
            "--systemctl-bin",
            join(fake.bin, "systemctl"),
            "--caddy-config",
            config,
            "--caddy-backup",
            backup,
            "--caddy-admin-address",
            adminAddress,
          ],
          fake.environment,
        )

        expect(result.exitCode).toBe(2)
        expect(result.stderr).toContain(`invalid Caddy admin address: ${adminAddress}`)
        expect(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)).toEqual([])
        expect(await readFile(config, "utf8")).toBe('{"candidate":true}\n')
      } finally {
        await rm(directory, { force: true, recursive: true })
      }
    }
  })

  test("keeps rollback dry-run non-mutating while showing the restore plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-dry-run-"))
    try {
      const fake = await fakeSystemd(directory)
      const caddy = await fakeCaddy(fake)
      const backup = join(directory, "legacy.json")
      const config = join(directory, "caddy.json")
      await Bun.write(backup, "{}\n")
      await Bun.write(config, '{"candidate":true}\n')
      const result = await command(
        "bash",
        [
          wrapper,
          "rollback",
          "--systemctl-bin",
          join(fake.bin, "systemctl"),
          "--caddy-binary",
          caddy,
          "--caddy-config",
          config,
          "--caddy-backup",
          backup,
        ],
        fake.environment,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("mode: dry-run")
      expect(result.stdout).toContain("would reload saved Caddy JSON")
      expect(result.stdout).toContain("--adapter ''")
      expect(await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
        `caddy validate --config ${backup} --adapter <empty>`,
      ])
      expect(await readFile(config, "utf8")).toBe('{"candidate":true}\n')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("does not mutate services when saved config validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-validation-failure-"))
    try {
      const fake = await fakeSystemd(directory)
      const caddy = await fakeCaddy(fake)
      const backup = join(directory, "legacy.json")
      const config = join(directory, "caddy.json")
      await Bun.write(backup, "{}\n")
      await Bun.write(config, '{"candidate":true}\n')
      fake.environment.FAKE_CADDY_FAIL_ON = "validate"
      const result = await command(
        "bash",
        [
          wrapper,
          "rollback",
          "--apply",
          "--systemctl-bin",
          join(fake.bin, "systemctl"),
          "--caddy-binary",
          caddy,
          "--caddy-config",
          config,
          "--caddy-backup",
          backup,
        ],
        fake.environment,
      )
      const calls = await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)

      expect(result.exitCode).toBe(42)
      expect(calls).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
        `caddy validate --config ${backup} --adapter <empty>`,
      ])
      expect(await readFile(config, "utf8")).toBe('{"candidate":true}\n')
      expect(result.stdout).not.toContain("rollback completed")
      expectNoCaddyServiceControl(calls)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("does not resume the legacy daemon when the live Caddy reload fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-reload-failure-"))
    try {
      const fake = await fakeSystemd(directory)
      const caddy = await fakeCaddy(fake)
      const backup = join(directory, "legacy.json")
      const config = join(directory, "caddy.json")
      await Bun.write(backup, "{}\n")
      await Bun.write(config, '{"candidate":true}\n')
      fake.environment.FAKE_CADDY_FAIL_ON = "reload"
      const result = await command(
        "bash",
        [
          wrapper,
          "rollback",
          "--apply",
          "--systemctl-bin",
          join(fake.bin, "systemctl"),
          "--caddy-binary",
          caddy,
          "--caddy-config",
          config,
          "--caddy-backup",
          backup,
        ],
        fake.environment,
      )
      const calls = await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)

      expect(result.exitCode).toBe(42)
      expect(calls).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
        `caddy validate --config ${backup} --adapter <empty>`,
        "stop project-registryd.service",
        "disable project-registryd.service",
        `caddy reload --config ${backup} --adapter <empty> --address 127.0.0.1:2019`,
      ])
      expect(await readFile(config, "utf8")).toBe('{"candidate":true}\n')
      expect(result.stdout).not.toContain("rollback completed")
      expectNoCaddyServiceControl(calls)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("requires an explicit saved config before mutating services", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-missing-backup-"))
    try {
      const fake = await fakeSystemd(directory)
      const caddy = await fakeCaddy(fake)
      const config = join(directory, "caddy.json")
      await Bun.write(config, "{}\n")
      const result = await command(
        "bash",
        [
          wrapper,
          "rollback",
          "--apply",
          "--systemctl-bin",
          join(fake.bin, "systemctl"),
          "--caddy-binary",
          caddy,
          "--caddy-config",
          config,
        ],
        fake.environment,
      )
      const calls = await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)

      expect(result.exitCode).toBe(2)
      expect(calls).toEqual(["cat caddy-projects.service", "cat project-registryd.service"])
      expectNoCaddyServiceControl(calls)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("stops on the first service failure and propagates its status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-failure-"))
    try {
      const fake = await fakeSystemd(directory)
      fake.environment.FAKE_SYSTEMCTL_FAIL_ON = "disable caddy-projects.service"
      const result = await command(
        "bash",
        [wrapper, "cutover", "--apply", "--systemctl-bin", join(fake.bin, "systemctl")],
        fake.environment,
      )
      const calls = await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)

      expect(result.exitCode).toBe(23)
      expect(calls).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
        "stop caddy-projects.service",
        "disable caddy-projects.service",
      ])
      expectNoCaddyServiceControl(calls)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("fails cutover when the replacement daemon is not active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-cutover-inactive-"))
    try {
      const fake = await fakeSystemd(directory)
      fake.environment.FAKE_SYSTEMCTL_FAIL_ON = "is-active --quiet project-registryd.service"
      const result = await command(
        "bash",
        [wrapper, "cutover", "--apply", "--systemctl-bin", join(fake.bin, "systemctl")],
        fake.environment,
      )
      const calls = await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)

      expect(result.exitCode).toBe(23)
      expect(calls).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
        "stop caddy-projects.service",
        "disable caddy-projects.service",
        "daemon-reload",
        "enable project-registryd.service",
        "start project-registryd.service",
        "is-active --quiet project-registryd.service",
      ])
      expect(result.stdout).not.toContain("cutover completed")
      expectNoCaddyServiceControl(calls)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("fails rollback when the legacy daemon is not active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-rollback-inactive-"))
    try {
      const fake = await fakeSystemd(directory)
      const caddy = await fakeCaddy(fake)
      const backup = join(directory, "legacy.json")
      const config = join(directory, "caddy.json")
      await Bun.write(backup, "{}\n")
      await Bun.write(config, '{"candidate":true}\n')
      fake.environment.FAKE_SYSTEMCTL_FAIL_ON = "is-active --quiet caddy-projects.service"
      const result = await command(
        "bash",
        [
          wrapper,
          "rollback",
          "--apply",
          "--systemctl-bin",
          join(fake.bin, "systemctl"),
          "--caddy-binary",
          caddy,
          "--caddy-config",
          config,
          "--caddy-backup",
          backup,
        ],
        fake.environment,
      )
      const calls = await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)

      expect(result.exitCode).toBe(23)
      expect(calls).toEqual([
        "cat caddy-projects.service",
        "cat project-registryd.service",
        `caddy validate --config ${backup} --adapter <empty>`,
        "stop project-registryd.service",
        "disable project-registryd.service",
        `caddy reload --config ${backup} --adapter <empty> --address 127.0.0.1:2019`,
        "daemon-reload",
        "enable caddy-projects.service",
        "start caddy-projects.service",
        "is-active --quiet caddy-projects.service",
      ])
      expect(await readFile(config, "utf8")).toBe("{}\n")
      expect(result.stdout).not.toContain("rollback completed")
      expectNoCaddyServiceControl(calls)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("does not mutate after a read-only unit preflight fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-wrapper-preflight-failure-"))
    try {
      const fake = await fakeSystemd(directory)
      fake.environment.FAKE_SYSTEMCTL_FAIL_ON = "cat project-registryd.service"
      const result = await command(
        "bash",
        [wrapper, "cutover", "--apply", "--systemctl-bin", join(fake.bin, "systemctl")],
        fake.environment,
      )
      const calls = await logLines(fake.environment.FAKE_SYSTEMCTL_LOG)

      expect(result.exitCode).toBe(23)
      expect(calls).toEqual(["cat caddy-projects.service", "cat project-registryd.service"])
      expect(calls.some((call) => /\b(stop|disable|enable|start|daemon-reload)\b/.test(call))).toBe(false)
      expectNoCaddyServiceControl(calls)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("delegates prepare to prepare-leo with an implicit dry-run", async () => {
    const script = await readFile(wrapper, "utf8")

    expect(script).toContain('"$SCRIPT_DIR/prepare-leo.bash"')
    expect(script).toContain('mode_argument="--dry-run"')
    expect(script).not.toContain("--old-caddy-service")
    expect(script).not.toContain("--new-caddy-service")
    expect(script).not.toContain("--old-caddy-user")
    expect(script).not.toMatch(/curl|caddy\s+(run|stop)\b/)
  })
})
