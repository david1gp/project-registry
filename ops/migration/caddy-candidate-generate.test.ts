import { describe, expect, test } from "bun:test"
import { chmod, cp, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const migrationDirectory = import.meta.dir
const candidateScript = join(migrationDirectory, "caddy-candidate-generate.ts")
const legacyMigrationScript = join(migrationDirectory, "legacy-migrate.ts")
const fixtureDirectory = join(migrationDirectory, "fixtures")
const legacyRepositoryFixture = join(fixtureDirectory, "legacy-repository")
const softwareProjectsFixture = join(fixtureDirectory, "software-projects")
const nameMappingFixture = join(fixtureDirectory, "software-name-mapping.json")

type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

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

async function migratedRepository(): Promise<{ directory: string; repository: string }> {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-candidate-"))
  const sourceRepository = join(directory, "repository")
  const repository = join(directory, "migrated-repository")
  await cp(legacyRepositoryFixture, sourceRepository, { recursive: true })

  for (const args of [
    ["-C", sourceRepository, "init", "-b", "main"],
    ["-C", sourceRepository, "config", "user.email", "fixture@example.test"],
    ["-C", sourceRepository, "config", "user.name", "Candidate fixture"],
    ["-C", sourceRepository, "add", "."],
    ["-C", sourceRepository, "commit", "-m", "fixture"],
  ]) {
    const result = await command("git", args)
    expect(result.exitCode).toBe(0)
  }

  const migration = await command("bun", [
    "run",
    legacyMigrationScript,
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

async function repositoryFilesSnapshot(directory: string, relativeDirectory = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory === "" ? entry.name : join(relativeDirectory, entry.name)
    const path = join(directory, entry.name)
    const pathStat = await lstat(path)
    if (pathStat.isDirectory()) {
      Object.assign(snapshot, await repositoryFilesSnapshot(path, relativePath))
    } else if (pathStat.isFile()) {
      snapshot[relativePath] = (await readFile(path)).toString("base64")
    }
  }
  return snapshot
}

describe("offline Caddy candidate generation", () => {
  test("generates deterministic JSON from a migrated repository and legacy Leo OIDC names", async () => {
    const { directory, repository } = await migratedRepository()
    try {
      const environment = cleanEnvironment({
        CADDY_PROJECTS_OIDC_ISSUER: "https://auth.example",
        CADDY_PROJECTS_OIDC_CLIENT_ID: "client-id",
        CADDY_PROJECTS_OIDC_CLIENT_SECRET: "client-secret",
        CADDY_PROJECTS_OIDC_COOKIE_SECRET: "0".repeat(32),
      })
      const args = ["run", candidateScript, "--repository", repository]
      await chmod(join(repository, ".git", "config"), 0o444)
      const before = await repositoryFilesSnapshot(repository)
      const first = await command("bun", args, environment)
      const second = await command("bun", args, environment)
      const after = await repositoryFilesSnapshot(repository)

      expect(first.exitCode).toBe(0)
      expect(first.stderr).toBe("")
      expect(second.exitCode).toBe(0)
      expect(second.stdout).toBe(first.stdout)
      expect(after).toEqual(before)

      const config = JSON.parse(first.stdout) as {
        apps: {
          http: { servers: { srv0: { listen: string[]; routes: Array<{ match: Array<{ host: string[] }> }> } } }
          oidc: unknown
        }
      }
      expect(config.apps.http.servers.srv0.listen).toEqual([":443"])
      expect(config.apps.http.servers.srv0.routes.map((route) => route.match[0]?.host)).toEqual([
        ["browse.example"],
        ["docs.example"],
        ["proxy.example"],
        ["spa.example"],
        ["static.example"],
      ])
      expect(config.apps.oidc).toBeDefined()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("writes the same deterministic candidate to an explicit output path", async () => {
    const { directory, repository } = await migratedRepository()
    try {
      const output = join(directory, "candidate.json")
      const environment = cleanEnvironment()
      const result = await command(
        "bun",
        ["run", candidateScript, "--repository", repository, "--output", output],
        environment,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("")
      expect(await readFile(output, "utf8")).toMatch(/\n$/)
      expect(JSON.parse(await readFile(output, "utf8"))).toHaveProperty("apps.http.servers.srv0")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("rejects invalid repository records without attempting live Caddy operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-candidate-invalid-"))
    const repository = join(directory, "repository")
    try {
      await cp(legacyRepositoryFixture, repository, { recursive: true })
      const invalidPath = join(repository, "projects", "leo", "invalid.json")
      await Bun.write(
        invalidPath,
        JSON.stringify({ schemaVersion: 1, owner: "leo", name: "invalid", caddy: { port: 0 } }),
      )
      for (const args of [
        ["-C", repository, "init", "-b", "main"],
        ["-C", repository, "config", "user.email", "fixture@example.test"],
        ["-C", repository, "config", "user.name", "Candidate fixture"],
        ["-C", repository, "add", "."],
        ["-C", repository, "commit", "-m", "fixture"],
      ]) {
        const result = await command("git", args)
        expect(result.exitCode).toBe(0)
      }

      const result = await command("bun", ["run", candidateScript, "--repository", repository], cleanEnvironment())
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("candidate generation failed")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
