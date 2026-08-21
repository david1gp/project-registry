import { describe, expect, test } from "bun:test"
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const migrationScript = join(import.meta.dir, "legacy-migrate.ts")
const fixtureDirectory = join(import.meta.dir, "fixtures")
const legacyRepositoryFixture = join(fixtureDirectory, "legacy-repository")
const softwareProjectsFixture = join(fixtureDirectory, "software-projects")
const nameMappingFixture = join(fixtureDirectory, "software-name-mapping.json")

type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

async function command(commandName: string, args: string[], cwd?: string): Promise<CommandResult> {
  const process = Bun.spawn([commandName, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
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

async function createRepository(): Promise<{ directory: string; repository: string }> {
  const directory = await mkdtemp(join(tmpdir(), "project-registry-migration-"))
  const repository = join(directory, "repository")
  await cp(legacyRepositoryFixture, repository, { recursive: true })
  const initR = await command("git", ["-C", repository, "init", "-b", "main"])
  expect(initR.exitCode).toBe(0)
  for (const [key, value] of [
    ["user.email", "fixture@example.test"],
    ["user.name", "Migration fixture"],
  ]) {
    const result = await command("git", ["-C", repository, "config", key, value])
    expect(result.exitCode).toBe(0)
  }
  const addR = await command("git", ["-C", repository, "add", "."])
  expect(addR.exitCode).toBe(0)
  const commitR = await command("git", ["-C", repository, "commit", "-m", "fixture"])
  expect(commitR.exitCode).toBe(0)
  const remoteR = await command("git", ["-C", repository, "remote", "add", "origin", "https://example.test/legacy.git"])
  expect(remoteR.exitCode).toBe(0)
  for (const [key, value] of [
    ["branch.main.remote", "origin"],
    ["branch.main.merge", "refs/heads/main"],
  ]) {
    const result = await command("git", ["-C", repository, "config", key, value])
    expect(result.exitCode).toBe(0)
  }
  return { directory, repository }
}

async function migration(
  repository: string,
  extraArgs: string[] = [],
  destination = join(repository, "..", "migrated-repository"),
): Promise<CommandResult> {
  return command("bun", [
    "run",
    migrationScript,
    "--repository",
    repository,
    "--destination-repository",
    destination,
    "--software-projects",
    softwareProjectsFixture,
    "--software-owner",
    "leo",
    "--name-mapping",
    nameMappingFixture,
    "--json",
    ...extraArgs,
  ])
}

async function gitState(repository: string): Promise<string> {
  const values = await Promise.all([
    command("git", ["-C", repository, "rev-parse", "HEAD"]),
    command("git", ["-C", repository, "branch", "--show-current"]),
    command("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"]),
    command("git", ["-C", repository, "config", "--local", "--list"]),
    command("git", ["-C", repository, "remote", "-v"]),
  ])
  return values.map((value) => `${value.exitCode}\n${value.stdout}\n${value.stderr}`).join("\n---\n")
}

async function repositoryBytesSnapshot(directory: string, relativeDirectory = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory === "" ? entry.name : join(relativeDirectory, entry.name)
    const path = join(directory, entry.name)
    const pathStat = await lstat(path)
    if (pathStat.isDirectory()) Object.assign(snapshot, await repositoryBytesSnapshot(path, relativePath))
    else if (pathStat.isFile()) snapshot[relativePath] = (await readFile(path)).toString("base64")
  }
  return snapshot
}

async function addCase(repository: string, caseName: string): Promise<void> {
  const source = join(fixtureDirectory, "cases", `${caseName}.json`)
  await cp(source, join(repository, "projects", "leo", `${caseName}.json`))
  const addR = await command("git", ["-C", repository, "add", "."])
  expect(addR.exitCode).toBe(0)
  const commitR = await command("git", ["-C", repository, "commit", "-m", `fixture ${caseName}`])
  expect(commitR.exitCode).toBe(0)
}

async function fixtureProject(output: string, name: string): Promise<Record<string, unknown>> {
  const report = JSON.parse(output) as { records: { project: Record<string, unknown> }[] }
  const record = report.records.find((entry) => entry.project.name === name)
  if (record === undefined) throw new Error(`missing project ${name}`)
  return record.project
}

describe("legacy migration fixtures", () => {
  test("dry-run converts routing settings without mutating the repository", async () => {
    const { directory, repository } = await createRepository()
    try {
      const before = await readFile(join(repository, "projects", "leo", "proxy.json"), "utf8")
      const beforeGit = await gitState(repository)
      const beforeBytes = await repositoryBytesSnapshot(repository)
      const result = await migration(repository, ["--dry-run"])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const report = JSON.parse(result.stdout) as {
        mode: string
        records: { project: Record<string, unknown> }[]
        sharedConversions: string[]
      }
      expect(report.mode).toBe("dry-run")
      expect(report.records).toHaveLength(7)
      expect(report.sharedConversions).toEqual(["leo/proxy"])

      const proxy = await fixtureProject(result.stdout, "proxy")
      expect(proxy).toMatchObject({
        github: "https://github.com/example/proxy",
        owner: "leo",
        services: ["proxy.service"],
        type: "own",
      })
      expect(proxy.caddy).toMatchObject({
        access: "internal",
        docs: false,
        domains: ["proxy.example"],
        flushInterval: 5,
        headerUp: { Host: "proxy.internal", "X-Forwarded-Proto": "https" },
        kind: "proxy",
        oidcPaths: ["/private/*"],
        routed: "/api/*",
      })

      const staticProject = await fixtureProject(result.stdout, "static")
      expect(staticProject.caddy).toMatchObject({
        denyDotfiles: true,
        kind: "static",
        path: "/srv/static",
        staticAllow: ["/assets", "/index.html"],
      })
      expect((await fixtureProject(result.stdout, "docs")).caddy).toMatchObject({ docs: true, docsPath: "/srv/docs" })
      expect((await fixtureProject(result.stdout, "browse")).caddy).toMatchObject({
        browse: true,
        browseTemplate: "directory.html",
      })
      expect((await fixtureProject(result.stdout, "spa")).caddy).toMatchObject({ spa: true })
      expect((await fixtureProject(result.stdout, "disabled")).caddy).toMatchObject({
        disabled: true,
        domains: ["proxy.example"],
        port: 3101,
      })

      const mapped = await fixtureProject(result.stdout, "project-name")
      expect(mapped).toMatchObject({
        caddy: null,
        name: "project-name",
        order: 12,
        owner: "leo",
        services: ["project-name.service"],
        type: "internal",
      })
      expect(await readFile(join(repository, "projects", "leo", "proxy.json"), "utf8")).toBe(before)
      expect(await readdir(repository)).not.toContain("migrations")
      expect(await gitState(repository)).toBe(beforeGit)
      expect(await repositoryBytesSnapshot(repository)).toEqual(beforeBytes)
      expect(await readdir(join(directory, "migrated-repository")).catch(() => [])).toEqual([])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("apply leaves the source unchanged and creates a metadata-preserving destination", async () => {
    const { directory, repository } = await createRepository()
    try {
      const sourceRevision = (await command("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()
      const sourceGitBefore = await gitState(repository)
      const sourceBytesBefore = await repositoryBytesSnapshot(repository)
      const result = await migration(repository, ["--apply"])
      const destination = join(directory, "migrated-repository")

      expect(result.exitCode).toBe(0)
      const report = JSON.parse(result.stdout) as {
        completed: { commit: string }
        marker: { projectCount: number; sourceBranch: string; sourceRevision: string }
        mode: string
      }
      expect(report.mode).toBe("apply")
      expect(report.destinationRepository).toBe(destination)
      expect(report.completed.commit).toBe(
        (await command("git", ["-C", destination, "rev-parse", "HEAD"])).stdout.trim(),
      )
      expect(report.marker).toMatchObject({ projectCount: 7, sourceBranch: "main", sourceRevision })
      expect(await readFile(join(destination, "migrations", "legacy-v1.json"), "utf8")).toContain(
        '"migration": "legacy-v1"',
      )
      expect((await command("git", ["-C", destination, "log", "-1", "--format=%s"])).stdout.trim()).toBe(
        "project-registry migrate legacy-v1",
      )
      expect((await command("git", ["-C", destination, "show", "-s", "--format=%an <%ae>"])).stdout.trim()).toBe(
        "project-registry <project-registry@localhost>",
      )
      expect((await command("git", ["-C", destination, "rev-parse", "HEAD^"])).stdout.trim()).toBe(sourceRevision)
      expect((await command("git", ["-C", destination, "branch", "--show-current"])).stdout.trim()).toBe("main")
      expect((await command("git", ["-C", destination, "remote", "get-url", "origin"])).stdout.trim()).toBe(
        "https://example.test/legacy.git",
      )
      expect((await command("git", ["-C", destination, "config", "--get", "branch.main.remote"])).stdout.trim()).toBe(
        "origin",
      )
      expect((await command("git", ["-C", destination, "config", "--get", "branch.main.merge"])).stdout.trim()).toBe(
        "refs/heads/main",
      )
      expect(await readFile(join(destination, ".git", "objects", "info", "alternates"), "utf8").catch(() => "")).toBe(
        "",
      )
      expect(await gitState(repository)).toBe(sourceGitBefore)
      expect(await repositoryBytesSnapshot(repository)).toEqual(sourceBytesBefore)
      expect(await readdir(repository)).not.toContain("migrations")

      const destinationBeforeRepeat = await gitState(destination)
      const repeat = await migration(repository, ["--apply"])
      expect(repeat.exitCode).toBe(0)
      expect(await gitState(destination)).toBe(destinationBeforeRepeat)
      expect(JSON.parse(repeat.stdout).completed.commit).toBe(report.completed.commit)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test.each(["duplicate-domain", "duplicate-port"])("rejects active %s collisions", async (caseName) => {
    const { directory, repository } = await createRepository()
    try {
      await addCase(repository, caseName)
      const result = await migration(repository)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(
        caseName === "duplicate-domain" ? "active domain collision" : "active port collision",
      )
      expect(await readdir(repository)).not.toContain("migrations")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("rejects template records before writing anything", async () => {
    const { directory, repository } = await createRepository()
    try {
      await addCase(repository, "template")
      const result = await migration(repository)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("template records are unsupported")
      expect(await readdir(repository)).not.toContain("migrations")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("refuses the source as destination and refuses to replace a non-migration destination", async () => {
    const { directory, repository } = await createRepository()
    try {
      const samePath = await migration(repository, ["--apply"], repository)
      expect(samePath.exitCode).toBe(1)
      expect(samePath.stderr).toContain("source and destination repositories must be different")

      const destination = join(directory, "existing-destination")
      await mkdir(destination)
      await Bun.write(join(destination, "sentinel.txt"), "not-a-repository\n")
      const existingPath = await migration(repository, ["--apply"], destination)
      expect(existingPath.exitCode).toBe(1)
      expect(existingPath.stderr).toContain("refusing to replace a non-migration destination")
      expect(await readFile(join(destination, "sentinel.txt"), "utf8")).toBe("not-a-repository\n")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
