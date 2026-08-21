import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const migrationDirectory = import.meta.dir
const preflightScript = join(migrationDirectory, "caddy-dependency-preflight.ts")

type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

async function command(commandName: string, args: string[]): Promise<CommandResult> {
  const process = Bun.spawn([commandName, ...args], { stderr: "pipe", stdout: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stderr, stdout }
}

async function currentUser(): Promise<string> {
  const result = await command("id", ["-un"])
  expect(result.exitCode).toBe(0)
  return result.stdout.trim()
}

function candidate(staticRoot: string, template: string, port: number): Record<string, unknown> {
  return {
    apps: {
      http: {
        servers: {
          srv0: {
            routes: [
              {
                match: [{ host: ["fixture.example"] }],
                handle: [
                  { handler: "vars", root: staticRoot },
                  { handler: "file_server", browse: { template_file: template } },
                  { handler: "reverse_proxy", upstreams: [{ dial: `localhost:${port}` }] },
                ],
              },
            ],
          },
        },
      },
    },
  }
}

async function writeCandidate(directory: string, value: Record<string, unknown>): Promise<string> {
  const path = join(directory, "candidate.json")
  await Bun.write(path, `${JSON.stringify(value)}\n`)
  return path
}

describe("Caddy dependency preflight", () => {
  test("documents the absolute default access runner", async () => {
    const result = await command("bun", ["run", preflightScript, "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("default: /usr/sbin/runuser")
    expect(result.stdout).toContain("--allow-missing-filesystem")
  })

  test("passes readable roots, browse template, and listening loopback backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-pass-"))
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    try {
      const root = join(directory, "static")
      const template = join(directory, "directory.html")
      await mkdir(root, { recursive: true })
      await Bun.write(template, "<html></html>\n")
      const candidatePath = await writeCandidate(directory, candidate(root, template, server.port))
      const result = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        "none",
      ])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("dependency preflight: PASS\n")
    } finally {
      server.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("keeps missing paths fatal while allowing stopped backends when requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-fail-"))
    try {
      const missingRoot = join(directory, "missing-root")
      const missingTemplate = join(directory, "missing-template.html")
      const candidatePath = await writeCandidate(directory, candidate(missingRoot, missingTemplate, 1))
      const result = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        "none",
        "--allow-missing-backends",
      ])

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("dependency preflight failed:")
      expect(result.stderr).toContain(`static root is absent or inaccessible: ${missingRoot}`)
      expect(result.stderr).toContain(`browse template is absent or inaccessible: ${missingTemplate}`)
      expect(result.stderr).toContain("dependency preflight warning: proxy backend is not listening: localhost:1")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("keeps stopped backends fatal without the opt-in mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-strict-"))
    try {
      const candidatePath = await writeCandidate(directory, {
        apps: {
          http: {
            servers: {
              srv0: { routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:1" }] }] }] },
            },
          },
        },
      })
      const result = await command("bun", ["run", preflightScript, "--candidate", candidatePath])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("proxy backend is not listening: localhost:1")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("reports missing paths and stopped backends as deterministic warnings when requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-warn-"))
    try {
      const missingRoot = join(directory, "missing-root")
      const missingTemplate = join(directory, "missing-template.html")
      const candidatePath = await writeCandidate(directory, candidate(missingRoot, missingTemplate, 1))
      const result = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        "none",
        "--allow-missing-backends",
        "--allow-missing-filesystem",
      ])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("dependency preflight: PASS\n")
      expect(result.stderr).toBe(
        [
          `dependency preflight warning: browse template is absent or inaccessible: ${missingTemplate}`,
          "dependency preflight warning: proxy backend is not listening: localhost:1",
          `dependency preflight warning: static root is absent or inaccessible: ${missingRoot}`,
          "",
        ].join("\n"),
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("uses the configured user command instead of permission-bit checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-access-"))
    try {
      const root = join(directory, "static")
      const template = join(directory, "directory.html")
      const commandPath = join(directory, "access-check")
      await mkdir(root, { recursive: true })
      await Bun.write(template, "<html></html>\n")
      await chmod(root, 0o000)
      await Bun.write(
        commandPath,
        `#!/bin/sh
if [ "$1" = "-u" ] && [ "$3" = "--" ] && [ "$4" = "id" ]; then printf '%s\\n' "$(id -u)"; exit 0; fi
if [ "$1" = "-u" ] && [ "$3" = "--" ] && [ "$4" = "test" ]; then exit 0; fi
exit 1
`,
      )
      await chmod(commandPath, 0o755)
      const candidatePath = await writeCandidate(directory, candidate(root, template, 1))
      const result = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        commandPath,
        "--allow-missing-backends",
      ])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("dependency preflight warning: proxy backend is not listening: localhost:1")
      expect(result.stderr).not.toContain(`not readable/traversable by Caddy: ${root}`)
    } finally {
      await chmod(join(directory, "static"), 0o700).catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("keeps access-runner execution failures fatal in warning mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-access-runner-failure-"))
    try {
      const root = join(directory, "static")
      const commandPath = join(directory, "access-check")
      await mkdir(root, { recursive: true })
      await Bun.write(
        commandPath,
        `#!/bin/sh
if [ "$1" = "-u" ] && [ "$3" = "--" ] && [ "$4" = "id" ]; then
  printf '%s\\n' "$(id -u)"
  rm -- "$0"
  exit 0
fi
exit 0
`,
      )
      await chmod(commandPath, 0o755)
      const candidatePath = await writeCandidate(directory, {
        apps: { http: { servers: { srv0: { routes: [{ handle: [{ handler: "vars", root }] }] } } } },
      })
      const result = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        commandPath,
        "--allow-missing-backends",
        "--allow-missing-filesystem",
      ])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Caddy access command unavailable")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("reports a Caddy traversal failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-permission-"))
    try {
      const blocked = join(directory, "blocked")
      const root = join(blocked, "static")
      await mkdir(root, { recursive: true })
      await chmod(blocked, 0o600)
      const candidatePath = await writeCandidate(directory, {
        apps: { http: { servers: { srv0: { routes: [{ handle: [{ handler: "vars", root }] }] } } } },
      })
      const result = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        "none",
      ])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(`not traversable by Caddy: ${blocked}`)
    } finally {
      await chmod(join(directory, "blocked"), 0o700).catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("fails clearly when the requested access command is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-missing-access-"))
    try {
      const root = join(directory, "static")
      const template = join(directory, "directory.html")
      await mkdir(root, { recursive: true })
      await Bun.write(template, "<html></html>\n")
      const candidatePath = await writeCandidate(directory, candidate(root, template, 1))
      const result = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        join(directory, "missing-access-command"),
        "--allow-missing-backends",
        "--allow-missing-filesystem",
      ])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Caddy access command unavailable")
      expect(result.stderr).not.toContain("not readable/traversable by Caddy")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("fails clearly when the access command identity probe fails or mismatches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-preflight-identity-"))
    try {
      const root = join(directory, "static")
      const template = join(directory, "directory.html")
      await mkdir(root, { recursive: true })
      await Bun.write(template, "<html></html>\n")
      const candidatePath = await writeCandidate(directory, candidate(root, template, 1))
      const failedCommand = join(directory, "failed-access-command")
      const mismatchCommand = join(directory, "mismatch-access-command")
      await Bun.write(failedCommand, "#!/bin/sh\nexit 42\n")
      await Bun.write(mismatchCommand, "#!/bin/sh\nprintf '999999\\n'\n")
      await chmod(failedCommand, 0o755)
      await chmod(mismatchCommand, 0o755)

      const failedProbe = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        failedCommand,
        "--allow-missing-backends",
        "--allow-missing-filesystem",
      ])
      const mismatch = await command("bun", [
        "run",
        preflightScript,
        "--candidate",
        candidatePath,
        "--caddy-user",
        await currentUser(),
        "--caddy-access-command",
        mismatchCommand,
        "--allow-missing-backends",
        "--allow-missing-filesystem",
      ])

      expect(failedProbe.exitCode).toBe(1)
      expect(failedProbe.stderr).toContain("Caddy access command identity probe failed")
      expect(mismatch.exitCode).toBe(1)
      expect(mismatch.stderr).toContain("Caddy access command identity mismatch")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
