import { describe, expect, test } from "bun:test"
import { chmod, cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const migrationDirectory = import.meta.dir
const candidateScript = join(migrationDirectory, "caddy-candidate-generate.ts")
const migrationScript = join(migrationDirectory, "legacy-migrate.ts")
const parityScript = join(migrationDirectory, "caddy-semantic-parity.ts")
const fixtureDirectory = join(migrationDirectory, "fixtures")
const legacyRepositoryFixture = join(fixtureDirectory, "legacy-repository")
const softwareProjectsFixture = join(fixtureDirectory, "software-projects")
const nameMappingFixture = join(fixtureDirectory, "software-name-mapping.json")

type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

type JsonRecord = Record<string, unknown>

async function command(
  commandName: string,
  args: string[],
  environment?: Record<string, string>,
): Promise<CommandResult> {
  const process = Bun.spawn([commandName, ...args], {
    ...(environment === undefined ? {} : { env: environment }),
    stderr: "pipe",
    stdout: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stderr, stdout }
}

function cleanEnvironment(values: Record<string, string> = {}): Record<string, string> {
  const environment = { ...Bun.env } as Record<string, string>
  for (const name of [
    "PROJECT_REGISTRY_OIDC_ISSUER",
    "PROJECT_REGISTRY_OIDC_PROVIDER",
    "PROJECT_REGISTRY_OIDC_CLIENT_ID",
    "PROJECT_REGISTRY_OIDC_CLIENT_SECRET",
    "PROJECT_REGISTRY_OIDC_COOKIE_SECRET",
    "CADDY_PROJECTS_OIDC_ISSUER",
    "CADDY_PROJECTS_OIDC_PROVIDER",
    "CADDY_PROJECTS_OIDC_CLIENT_ID",
    "CADDY_PROJECTS_OIDC_CLIENT_SECRET",
    "CADDY_PROJECTS_OIDC_COOKIE_SECRET",
  ]) {
    delete environment[name]
  }
  Object.assign(environment, values)
  return environment
}

async function migratedRepository(): Promise<{ directory: string; repository: string }> {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-parity-"))
  const sourceRepository = join(directory, "repository")
  const repository = join(directory, "migrated-repository")
  await cp(legacyRepositoryFixture, sourceRepository, { recursive: true })
  for (const args of [
    ["-C", sourceRepository, "init", "-b", "main"],
    ["-C", sourceRepository, "config", "user.email", "fixture@example.test"],
    ["-C", sourceRepository, "config", "user.name", "Parity fixture"],
    ["-C", sourceRepository, "add", "."],
    ["-C", sourceRepository, "commit", "-m", "fixture"],
  ]) {
    expect((await command("git", args)).exitCode).toBe(0)
  }

  const migration = await command("bun", [
    "run",
    migrationScript,
    "--repository",
    sourceRepository,
    "--destination-repository",
    repository,
    "--software-projects",
    softwareProjectsFixture,
    "--software-owner",
    "leo",
    "--name-mapping",
    nameMappingFixture,
    "--apply",
    "--json",
  ])
  expect(migration.exitCode).toBe(0)
  return { directory, repository }
}

async function generatedFixture(): Promise<{
  candidate: JsonRecord
  directory: string
  legacyPath: string
  repository: string
}> {
  const repositoryFixture = await migratedRepository()
  const environment = cleanEnvironment({
    CADDY_PROJECTS_OIDC_ISSUER: "https://auth.example",
    CADDY_PROJECTS_OIDC_CLIENT_ID: "client-id",
    CADDY_PROJECTS_OIDC_CLIENT_SECRET: "client-secret",
    CADDY_PROJECTS_OIDC_COOKIE_SECRET: "0".repeat(32),
  })
  const candidateResult = await command(
    "bun",
    ["run", candidateScript, "--repository", repositoryFixture.repository],
    environment,
  )
  expect(candidateResult.exitCode).toBe(0)
  const candidate = JSON.parse(candidateResult.stdout) as JsonRecord
  const legacy = structuredClone(candidate)
  legacy.admin = { listen: "127.0.0.1:2019" }
  const routes = ((legacy.apps as JsonRecord).http as JsonRecord).servers as JsonRecord
  const server = routes.srv0 as JsonRecord
  ;(server.routes as unknown[]).reverse()
  const legacyPath = join(repositoryFixture.directory, "legacy.json")
  await Bun.write(legacyPath, `${JSON.stringify(legacy)}\n`)
  return {
    candidate,
    directory: repositoryFixture.directory,
    legacyPath,
    repository: repositoryFixture.repository,
  }
}

function routeForHost(config: JsonRecord, hostname: string): JsonRecord {
  const apps = config.apps as JsonRecord
  const http = apps.http as JsonRecord
  const servers = http.servers as JsonRecord
  const server = servers.srv0 as JsonRecord
  const route = (server.routes as JsonRecord[]).find((entry) => {
    const match = entry.match as JsonRecord[]
    return (match[0]?.host as string[] | undefined)?.includes(hostname)
  })
  if (route === undefined) throw new Error(`missing route for ${hostname}`)
  return route
}

function walkRecords(value: unknown, visit: (record: JsonRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkRecords(item, visit)
    return
  }
  if (value === null || typeof value !== "object") return
  const record = value as JsonRecord
  visit(record)
  for (const item of Object.values(record)) walkRecords(item, visit)
}

async function parityWithCandidate(legacyPath: string, candidate: JsonRecord, directory: string): Promise<JsonRecord> {
  const candidatePath = join(directory, "changed-candidate.json")
  await Bun.write(candidatePath, `${JSON.stringify(candidate)}\n`)
  const result = await command("bun", [
    "run",
    parityScript,
    "--legacy",
    legacyPath,
    "--candidate",
    candidatePath,
    "--json",
  ])
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout) as JsonRecord
}

describe("semantic Caddy parity", () => {
  test("ignores equivalent admin defaults and validates through the supplied binary", async () => {
    const fixture = await generatedFixture()
    try {
      const argsPath = join(fixture.directory, "caddy-args")
      const caddyPath = join(fixture.directory, "caddy")
      const accessCommand = join(fixture.directory, "run-as-caddy")
      const caddyUser = "nobody"
      const caddyGroup = "nogroup"
      await Bun.write(caddyPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CADDY_ARGS_FILE"\ncat >/dev/null\nexit 0\n`)
      await Bun.write(
        accessCommand,
        `#!/bin/sh\n[ "$1" = "-u" ] && [ "$2" = "${caddyUser}" ] && [ "$3" = "-g" ] && [ "$4" = "${caddyGroup}" ] && [ "$5" = "--" ] || exit 41\nshift 5\nexec "$@"\n`,
      )
      await chmod(caddyPath, 0o755)
      await chmod(accessCommand, 0o755)
      const environment = cleanEnvironment({
        CADDY_ARGS_FILE: argsPath,
        CADDY_PROJECTS_OIDC_CLIENT_ID: "client-id",
        CADDY_PROJECTS_OIDC_CLIENT_SECRET: "client-secret",
        CADDY_PROJECTS_OIDC_COOKIE_SECRET: "0".repeat(32),
        CADDY_PROJECTS_OIDC_ISSUER: "https://auth.example",
      })
      const result = await command(
        "bun",
        [
          "run",
          parityScript,
          "--legacy",
          fixture.legacyPath,
          "--repository",
          fixture.repository,
           "--caddy-bin",
           caddyPath,
            "--caddy-user",
             caddyUser,
            "--caddy-group",
             caddyGroup,
           "--caddy-access-command",
           accessCommand,
           "--validate",
          "--json",
        ],
        environment,
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout)).toMatchObject({
        differences: [],
        parity: true,
        validation: { requested: true, status: "passed" },
      })
      expect(await readFile(argsPath, "utf8")).toBe("validate\n--config\n-\n--adapter\n\n")
    } finally {
      await rm(fixture.directory, { force: true, recursive: true })
    }
  })

  test("reports actionable differences by semantic route category", async () => {
    const fixture = await generatedFixture()
    try {
      const baseCandidate = structuredClone(fixture.candidate)
      const mutations: { category: string; mutate: (candidate: JsonRecord) => void }[] = [
        {
          category: "listener",
          mutate: (candidate) => {
            const server = (((candidate.apps as JsonRecord).http as JsonRecord).servers as JsonRecord)
              .srv0 as JsonRecord
            server.listen = [":8443"]
          },
        },
        {
          category: "hostname",
          mutate: (candidate) => {
            const route = routeForHost(candidate, "proxy.example")
            ;((route.match as JsonRecord[])[0] as JsonRecord).host = ["changed.example"]
          },
        },
        {
          category: "proxy upstream/port",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "proxy.example"), (record) => {
              if (record.handler !== "reverse_proxy") return
              ;((record.upstreams as JsonRecord[])[0] as JsonRecord).dial = "localhost:3999"
            })
          },
        },
        {
          category: "static root/path",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "static.example"), (record) => {
              if (record.handler === "vars") record.root = "/srv/changed"
            })
          },
        },
        {
          category: "headers",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "proxy.example"), (record) => {
              if (record.handler !== "headers") return
              const response = record.response as JsonRecord | undefined
              if (response !== undefined) (response.set as JsonRecord).Routed = ["changed"]
            })
          },
        },
        {
          category: "docs/browse/SPA behavior",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "docs.example"), (record) => {
              if (record.handler === "vars") record.root = "/srv/changed-docs"
            })
          },
        },
        {
          category: "docs/browse/SPA behavior",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "static.example"), (record) => {
              if (record.handler === "file_server") record.browse = { template_file: "changed.html" }
            })
          },
        },
        {
          category: "docs/browse/SPA behavior",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "static.example"), (record) => {
              if (record.handler === "file_server") {
                record.handler = "rewrite"
                record.uri = "{http.request.uri.path}"
              }
            })
          },
        },
        {
          category: "access rules",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "static.example"), (record) => {
              const matcher = (record.match as JsonRecord[] | undefined)?.[0]
              if (matcher?.not === undefined) return
              ;((matcher.not as JsonRecord[])[0] as JsonRecord).path = ["/changed"]
            })
          },
        },
        {
          category: "OIDC handlers",
          mutate: (candidate) => {
            walkRecords(routeForHost(candidate, "proxy.example"), (record) => {
              if (record.handler === "oidc") record.provider = "changed"
            })
          },
        },
      ]

      for (const mutation of mutations) {
        const changedCandidate = structuredClone(baseCandidate)
        mutation.mutate(changedCandidate)
        const changedReport = await parityWithCandidate(fixture.legacyPath, changedCandidate, fixture.directory)
        const differences = changedReport.differences as JsonRecord[]
        if (!differences.some((difference) => difference.category === mutation.category)) {
          throw new Error(`missing ${mutation.category}: ${JSON.stringify(differences)}`)
        }
      }
    } finally {
      await rm(fixture.directory, { force: true, recursive: true })
    }
  })
})
