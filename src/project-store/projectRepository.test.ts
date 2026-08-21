import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gitStoreOpen, gitStoreRun, gitStoreWrite } from "#git-store"
import type { Project } from "../project/Project.js"
import type { ProjectRepositoryMutationOptions } from "./ProjectRepositoryMutationOptions.js"
import { projectRepositoryOpen } from "./projectRepositoryOpen.js"

const directories: string[] = []

function temporaryRepository(): string {
  const directory = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "project-registry-store-"))
  directories.push(directory)
  return directory
}

function project(name: string, port: number): Project {
  return {
    schemaVersion: 1,
    owner: "alice",
    name,
    type: "customer",
    order: Number.MAX_SAFE_INTEGER,
    services: [],
    caddy: {
      port,
      domains: [`${name}.example`],
      path: "",
      access: "external",
      kind: "proxy",
      docs: true,
      browse: false,
      headerUp: {},
      disabled: false,
      denyDotfiles: false,
      spa: false,
    },
  }
}

function ownedProject(owner: string, name: string, port: number): Project {
  return { ...project(name, port), owner }
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe("projectRepositoryOpen", () => {
  test("rejects unknown and cyclic runtime options before opening a Git store", async () => {
    const options: Record<string, unknown> = { dir: temporaryRepository() }
    options.cyclic = options

    const openR = await projectRepositoryOpen(options)

    expect(openR.success).toBe(false)
    if (openR.success) return
    expect(openR.errorMessage).toContain("Invalid key")
  })

  test("rejects an existing repository on a branch mismatch without changing its branch or HEAD", async () => {
    const directory = temporaryRepository()
    const gitR = await gitStoreOpen({ dir: directory, branch: "main" })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return

    const seedR = await gitStoreWrite(gitR.data, "projects/alice/catalog.json", project("catalog", 3000), "seed")
    expect(seedR.success).toBe(true)
    if (!seedR.success) return

    const checkoutR = await gitStoreRun(gitR.data, ["checkout", "-b", "other"])
    expect(checkoutR.success).toBe(true)
    if (!checkoutR.success) return
    const beforeR = await gitStoreRun(gitR.data, ["rev-parse", "HEAD"])
    expect(beforeR.success).toBe(true)
    if (!beforeR.success) return

    const openR = await projectRepositoryOpen({ dir: directory, branch: "main" })
    expect(openR.success).toBe(false)
    if (openR.success) return
    expect(openR.errorMessage).toContain("does not match configured branch")

    const branchR = await gitStoreRun(gitR.data, ["branch", "--show-current"])
    const afterR = await gitStoreRun(gitR.data, ["rev-parse", "HEAD"])
    expect(branchR.success).toBe(true)
    expect(afterR.success).toBe(true)
    if (!branchR.success || !afterR.success) return
    expect(branchR.data.trim()).toBe("other")
    expect(afterR.data.trim()).toBe(beforeR.data.trim())
  })

  test("commits CRUD changes, keeps identical writes local-no-op, and exposes path history", async () => {
    const openR = await projectRepositoryOpen({ dir: temporaryRepository() })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const repository = openR.data
    const firstR = await repository.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
    expect(firstR.success).toBe(true)
    if (!firstR.success) return
    expect(firstR.data.changed).toBe(true)
    expect(firstR.data.key).toEqual({ owner: "alice", name: "catalog" })
    expect(Object.keys(firstR.data.key)).toEqual(["owner", "name"])
    expect(firstR.data.localCommit.status).toBe("committed")
    expect(firstR.data.push.status).toBe("not-requested")

    const sameR = await repository.edit({ owner: "alice", name: "catalog" }, project("catalog", 3000), {
      actor: "alice",
      expectedRevision: firstR.data.revision,
    })
    expect(sameR.success).toBe(true)
    if (!sameR.success) return
    expect(sameR.data.changed).toBe(false)
    expect(sameR.data.key).toEqual({ owner: "alice", name: "catalog" })
    expect(Object.keys(sameR.data.key)).toEqual(["owner", "name"])
    expect(sameR.data.revision).toBe(firstR.data.revision)

    const editR = await repository.edit({ owner: "alice", name: "catalog" }, project("catalog", 3001), {
      actor: "admin",
      expectedRevision: firstR.data.revision,
    })
    expect(editR.success).toBe(true)
    if (!editR.success) return
    expect(editR.data.key).toEqual({ owner: "alice", name: "catalog" })
    expect(Object.keys(editR.data.key)).toEqual(["owner", "name"])

    const deleteR = await repository.delete(
      { owner: "alice", name: "catalog" },
      { actor: "admin", expectedRevision: editR.data.revision },
    )
    expect(deleteR.success).toBe(true)
    if (!deleteR.success) return
    expect(deleteR.data.key).toEqual({ owner: "alice", name: "catalog" })
    expect(Object.keys(deleteR.data.key)).toEqual(["owner", "name"])

    const readR = await repository.read()
    expect(readR.success).toBe(true)
    if (!readR.success) return
    expect(readR.data.projects).toEqual([])

    const historyR = await repository.history({ owner: "alice", name: "catalog" })
    expect(historyR.success).toBe(true)
    if (!historyR.success) return
    expect(historyR.data).toHaveLength(3)
    expect(historyR.data.every((commit) => commit.author === "project-registry")).toBe(true)
    expect(historyR.data.map((commit) => commit.message)).toEqual([
      "project-registry delete alice/catalog actor=admin",
      "project-registry edit alice/catalog actor=admin",
      "project-registry create alice/catalog actor=alice",
    ])
  })

  test("returns one newest-first owner history with one global limit and isolates owners", async () => {
    const openR = await projectRepositoryOpen({ dir: temporaryRepository() })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const repository = openR.data
    const firstR = await repository.create(ownedProject("alice", "first", 3000), {
      actor: "alice",
      expectedRevision: "",
    })
    expect(firstR.success).toBe(true)
    if (!firstR.success) return

    const otherR = await repository.create(ownedProject("bob", "other", 3001), {
      actor: "bob",
      expectedRevision: firstR.data.revision,
    })
    expect(otherR.success).toBe(true)
    if (!otherR.success) return

    const editR = await repository.edit({ owner: "alice", name: "first" }, ownedProject("alice", "first", 3002), {
      actor: "alice",
      expectedRevision: otherR.data.revision,
    })
    expect(editR.success).toBe(true)
    if (!editR.success) return

    const historyR = await repository.ownerHistory("alice")
    expect(historyR.success).toBe(true)
    if (!historyR.success) return
    expect(historyR.data.map((commit) => commit.message)).toEqual([
      "project-registry edit alice/first actor=alice",
      "project-registry create alice/first actor=alice",
    ])
    expect(historyR.data.some((commit) => commit.message.includes("bob/other"))).toBe(false)

    const limitedR = await repository.ownerHistory("alice", 1)
    expect(limitedR.success).toBe(true)
    if (!limitedR.success) return
    expect(limitedR.data.map((commit) => commit.message)).toEqual(["project-registry edit alice/first actor=alice"])
  })

  test("uses one owner path history operation and returns a multi-file commit once", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const createR = await openR.data.create(ownedProject("alice", "first", 3000), {
      actor: "alice",
      expectedRevision: "",
    })
    expect(createR.success).toBe(true)
    if (!createR.success) return

    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return

    const secondPath = join(directory, "projects", "alice", "second.json")
    const thirdPath = join(directory, "projects", "alice", "third.json")
    writeFileSync(secondPath, `${JSON.stringify(ownedProject("alice", "second", 3001))}\n`, "utf8")
    writeFileSync(thirdPath, `${JSON.stringify(ownedProject("alice", "third", 3002))}\n`, "utf8")
    const addR = await gitStoreRun(gitR.data, ["add", "--", "projects/alice/second.json", "projects/alice/third.json"])
    expect(addR.success).toBe(true)
    if (!addR.success) return
    const commitR = await gitStoreRun(gitR.data, ["commit", "-m", "multi-file alice update"])
    expect(commitR.success).toBe(true)
    if (!commitR.success) return

    const historyR = await openR.data.ownerHistory("alice")

    expect(historyR.success).toBe(true)
    if (!historyR.success) return
    expect(historyR.data.map((commit) => commit.message)).toEqual([
      "multi-file alice update",
      "project-registry create alice/first actor=alice",
    ])
    expect(new Set(historyR.data.map((commit) => commit.sha)).size).toBe(historyR.data.length)
  })

  test("rejects invalid owners before resolving an owner history path", async () => {
    const openR = await projectRepositoryOpen({ dir: temporaryRepository() })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    for (const owner of ["", ".", "..", ".git", "../alice", "alice/other", "alice\\other", "alice\nother"]) {
      const historyR = await openR.data.ownerHistory(owner)
      expect(historyR.success).toBe(false)
      if (historyR.success) return
      expect(historyR.errorMessage).toContain("owner is not a safe path segment")
    }
  })

  test("rejects malformed revisions at the repository mutation boundary", async () => {
    const openR = await projectRepositoryOpen({ dir: temporaryRepository() })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const options = (expectedRevision: unknown): ProjectRepositoryMutationOptions =>
      ({ actor: "alice", expectedRevision }) as unknown as ProjectRepositoryMutationOptions

    for (const expectedRevision of [
      undefined,
      null,
      1,
      " ",
      "\t",
      "not-a-revision",
      "A".repeat(40),
      `${"a".repeat(40)} `,
    ]) {
      const result = await openR.data.create(project("invalid", 3000), options(expectedRevision))
      expect(result.success).toBe(false)
    }

    const initialR = await openR.data.create(project("initial", 3000), options(""))
    expect(initialR.success).toBe(true)
    if (!initialR.success) return
    expect(initialR.data.revision).toMatch(/^[0-9a-f]{40}$/)

    for (const expectedRevision of ["", undefined, null, 1, " ", "\t", `${initialR.data.revision} `]) {
      const result = await openR.data.edit(
        { owner: "alice", name: "initial" },
        project("initial", 3001),
        options(expectedRevision),
      )
      expect(result.success).toBe(false)
    }
  })

  test("serializes concurrent changes and rejects stale revisions", async () => {
    const openR = await projectRepositoryOpen({ dir: temporaryRepository() })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const repository = openR.data
    const changes = await Promise.all([
      repository.create(project("one", 3000), { actor: "alice", expectedRevision: "" }),
      repository.create(project("two", 3001), { actor: "alice", expectedRevision: "" }),
    ])
    expect(changes.filter((result) => result.success)).toHaveLength(1)

    const staleR = await repository.edit({ owner: "alice", name: "one" }, project("one", 3010), {
      actor: "alice",
      expectedRevision: "b".repeat(40),
    })
    expect(staleR.success).toBe(false)
    if (staleR.success) return
    expect(staleR.errorMessage).toContain("revision mismatch")

    const readR = await repository.read()
    expect(readR.success).toBe(true)
    if (!readR.success) return
    expect(readR.data.projects.map((item) => item.name)).toEqual(["one"])
  })

  test("forces the daemon author and committer despite inherited Git identity variables", async () => {
    const directory = temporaryRepository()
    const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const
    const inherited = Object.fromEntries(keys.map((key) => [key, Bun.env[key]]))
    Bun.env.GIT_AUTHOR_NAME = "inherited-author"
    Bun.env.GIT_AUTHOR_EMAIL = "inherited-author@example.test"
    Bun.env.GIT_COMMITTER_NAME = "inherited-committer"
    Bun.env.GIT_COMMITTER_EMAIL = "inherited-committer@example.test"

    try {
      const openR = await projectRepositoryOpen({ dir: directory })
      expect(openR.success).toBe(true)
      if (!openR.success) return

      const mutationR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
      expect(mutationR.success).toBe(true)
      if (!mutationR.success) return

      const gitR = await gitStoreOpen({ dir: directory })
      expect(gitR.success).toBe(true)
      if (!gitR.success) return
      const identityR = await gitStoreRun(gitR.data, [
        "show",
        "-s",
        "--format=%an%n%ae%n%cn%n%ce",
        mutationR.data.revision,
      ])
      expect(identityR.success).toBe(true)
      if (!identityR.success) return
      expect(identityR.data.trim().split("\n")).toEqual([
        "project-registry",
        "project-registry@localhost",
        "project-registry",
        "project-registry@localhost",
      ])
    } finally {
      for (const key of keys) {
        const value = inherited[key]
        if (value === undefined) delete Bun.env[key]
        else Bun.env[key] = value
      }
    }
  })

  test("reports push failure separately from a successful local commit", async () => {
    const openR = await projectRepositoryOpen({ dir: temporaryRepository(), autoPush: true })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const mutationR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
    expect(mutationR.success).toBe(true)
    if (!mutationR.success) return
    expect(mutationR.data.localCommit.status).toBe("committed")
    expect(mutationR.data.push).toMatchObject({ requested: true, status: "failed" })

    const readR = await openR.data.read()
    expect(readR.success).toBe(true)
    if (!readR.success) return
    expect(readR.data.projects).toHaveLength(1)
  })

  test("pushes to a non-origin upstream remote and reports the pushed revision", async () => {
    const directory = temporaryRepository()
    const remoteDirectory = temporaryRepository()
    const wrongRemoteDirectory = temporaryRepository()
    const remoteStoreR = await gitStoreOpen({ dir: remoteDirectory })
    expect(remoteStoreR.success).toBe(true)
    if (!remoteStoreR.success) return

    const remotePath = join(remoteDirectory, "upstream.git")
    const wrongRemotePath = join(wrongRemoteDirectory, "origin.git")
    const initRemoteR = await gitStoreRun(remoteStoreR.data, ["init", "--bare", remotePath])
    expect(initRemoteR.success).toBe(true)
    const initWrongRemoteR = await gitStoreRun(remoteStoreR.data, ["init", "--bare", wrongRemotePath])
    expect(initWrongRemoteR.success).toBe(true)

    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return
    const seedR = await gitStoreWrite(gitR.data, "projects/alice/seed.json", project("seed", 3000), "seed")
    expect(seedR.success).toBe(true)
    const remoteAddR = await gitStoreRun(gitR.data, ["remote", "add", "upstream", remotePath])
    expect(remoteAddR.success).toBe(true)
    const wrongRemoteAddR = await gitStoreRun(gitR.data, ["remote", "add", "origin", wrongRemotePath])
    expect(wrongRemoteAddR.success).toBe(true)
    const initialPushR = await gitStoreRun(gitR.data, ["push", "--set-upstream", "upstream", "main:release"])
    expect(initialPushR.success).toBe(true)
    const pushDefaultR = await gitStoreRun(gitR.data, ["config", "remote.pushDefault", "origin"])
    expect(pushDefaultR.success).toBe(true)

    const openR = await projectRepositoryOpen({ dir: directory, autoPush: true })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const mutationR = await openR.data.create(project("catalog", 3001), {
      actor: "alice",
      expectedRevision: seedR.success ? seedR.data.trim() : "",
    })
    expect(mutationR.success).toBe(true)
    if (!mutationR.success) return
    expect(mutationR.data.push).toMatchObject({ requested: true, status: "pushed" })

    const remoteHeadR = await gitStoreRun(remoteStoreR.data, [
      "--git-dir",
      remotePath,
      "rev-parse",
      "refs/heads/release",
    ])
    expect(remoteHeadR.success).toBe(true)
    if (!remoteHeadR.success) return
    expect(remoteHeadR.data.trim()).toBe(mutationR.data.revision)
  })

  test("marks a clean malformed registry unready and identifies its path", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const gitR = await gitStoreOpen({
      dir: directory,
      authorName: "project-registry",
      authorEmail: "project-registry@localhost",
    })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return

    const invalidPath = join(directory, "projects", "alice", "broken.json")
    mkdirSync(join(directory, "projects", "alice"), { recursive: true })
    writeFileSync(invalidPath, "{ invalid json\n", "utf8")
    const addR = await gitStoreRun(gitR.data, ["add", "--", "projects/alice/broken.json"])
    expect(addR.success).toBe(true)
    const commitR = await gitStoreRun(gitR.data, ["commit", "-m", "manual invalid record"])
    expect(commitR.success).toBe(true)

    const readinessR = await openR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (!readinessR.success) return
    expect(readinessR.data).toMatchObject({ ready: false, clean: true })
    expect(readinessR.data.reason).toContain("broken.json")

    const readR = await openR.data.read()
    expect(readR.success).toBe(false)
    if (readR.success) return
    expect(readR.errorMessage).toContain("broken.json")
  })

  test("marks a clean colliding registry unready", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return
    const firstR = await gitStoreWrite(gitR.data, "projects/alice/one.json", project("one", 3000), "seed one")
    const secondR = await gitStoreWrite(gitR.data, "projects/alice/two.json", project("two", 3000), "seed two")
    expect(firstR.success).toBe(true)
    expect(secondR.success).toBe(true)

    const readinessR = await openR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (!readinessR.success) return
    expect(readinessR.data).toMatchObject({ ready: false, clean: true })
    expect(readinessR.data.reason).toContain("active port collision")
  })

  test("does not report readiness for an ignored invalid project file", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return
    writeFileSync(join(directory, ".gitignore"), "projects/alice/ignored.json\n", "utf8")
    const addR = await gitStoreRun(gitR.data, ["add", ".gitignore"])
    expect(addR.success).toBe(true)
    const commitR = await gitStoreRun(gitR.data, ["commit", "-m", "ignore invalid record"])
    expect(commitR.success).toBe(true)

    const ignoredPath = join(directory, "projects", "alice", "ignored.json")
    mkdirSync(join(directory, "projects", "alice"), { recursive: true })
    writeFileSync(ignoredPath, "{ invalid json\n", "utf8")

    const statusR = await gitStoreRun(gitR.data, ["status", "--porcelain", "--untracked-files=all"])
    expect(statusR.success).toBe(true)
    if (!statusR.success) return
    expect(statusR.data.trim()).toBe("")

    const readinessR = await openR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (!readinessR.success) return
    expect(readinessR.data).toMatchObject({ ready: false, clean: true })
    expect(readinessR.data.reason).toContain("ignored.json")
  })

  test("rejects a valid ignored project file instead of reading it into the registry", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return
    writeFileSync(join(directory, ".gitignore"), "projects/alice/ignored.json\n", "utf8")
    const addR = await gitStoreRun(gitR.data, ["add", ".gitignore"])
    expect(addR.success).toBe(true)
    const commitR = await gitStoreRun(gitR.data, ["commit", "-m", "ignore valid record"])
    expect(commitR.success).toBe(true)

    const ignoredPath = join(directory, "projects", "alice", "ignored.json")
    mkdirSync(join(directory, "projects", "alice"), { recursive: true })
    writeFileSync(ignoredPath, `${JSON.stringify(project("ignored", 3000))}\n`, "utf8")

    const readinessR = await openR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (!readinessR.success) return
    expect(readinessR.data).toMatchObject({ ready: false, clean: true })
    expect(readinessR.data.reason).toContain("not tracked by Git")

    const readR = await openR.data.read()
    expect(readR.success).toBe(false)
    if (readR.success) return
    expect(readR.errorMessage).toContain("not tracked by Git")
  })

  test("rejects reads, readiness, and mutations after the configured branch drifts", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const createR = await openR.data.create(project("seed", 3000), { actor: "alice", expectedRevision: "" })
    expect(createR.success).toBe(true)
    if (!createR.success) return

    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return
    const beforeR = await gitStoreRun(gitR.data, ["rev-parse", "HEAD"])
    expect(beforeR.success).toBe(true)
    if (!beforeR.success) return
    const checkoutR = await gitStoreRun(gitR.data, ["checkout", "-b", "other"])
    expect(checkoutR.success).toBe(true)
    if (!checkoutR.success) return

    const readR = await openR.data.read()
    expect(readR.success).toBe(false)
    if (readR.success) return
    expect(readR.errorMessage).toContain("does not match configured branch")

    const readinessR = await openR.data.readiness()
    expect(readinessR.success).toBe(false)
    if (readinessR.success) return
    expect(readinessR.errorMessage).toContain("does not match configured branch")

    const mutationR = await openR.data.create(project("new", 3001), {
      actor: "alice",
      expectedRevision: beforeR.success ? beforeR.data.trim() : "",
    })
    expect(mutationR.success).toBe(false)
    if (mutationR.success) return
    expect(mutationR.errorMessage).toContain("does not match configured branch")

    const afterR = await gitStoreRun(gitR.data, ["rev-parse", "HEAD"])
    expect(afterR.success).toBe(true)
    if (!afterR.success) return
    expect(afterR.data.trim()).toBe(beforeR.data.trim())
  })

  test("rejects history delimiter and control characters in actors", async () => {
    const openR = await projectRepositoryOpen({ dir: temporaryRepository() })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const sanitizedR = await openR.data.create(project("sanitized", 3000), {
      actor: "alice\nadmin",
      expectedRevision: "",
    })
    expect(sanitizedR.success).toBe(true)
    if (!sanitizedR.success) return

    const invalidR = await openR.data.create(project("invalid", 3001), {
      actor: "alice\u001fadmin",
      expectedRevision: sanitizedR.success ? sanitizedR.data.revision : "",
    })
    expect(invalidR.success).toBe(false)
    if (invalidR.success) return
    expect(invalidR.errorMessage).toContain("control characters")

    const historyR = await openR.data.history({ owner: "alice", name: "sanitized" })
    expect(historyR.success).toBe(true)
    if (!historyR.success) return
    expect(historyR.data[0]?.message).toBe("project-registry create alice/sanitized actor=alice admin")
  })

  test("starts unready when dirty and recovers the worktree from HEAD", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const createR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
    expect(createR.success).toBe(true)
    if (!createR.success) return

    const remoteDirectory = temporaryRepository()
    const remoteStoreR = await gitStoreOpen({ dir: remoteDirectory })
    expect(remoteStoreR.success).toBe(true)
    if (!remoteStoreR.success) return
    const remotePath = join(remoteDirectory, "upstream.git")
    const initRemoteR = await gitStoreRun(remoteStoreR.data, ["init", "--bare", remotePath])
    expect(initRemoteR.success).toBe(true)
    if (!initRemoteR.success) return
    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return
    const remoteAddR = await gitStoreRun(gitR.data, ["remote", "add", "upstream", remotePath])
    expect(remoteAddR.success).toBe(true)
    const pushR = await gitStoreRun(gitR.data, ["push", "--set-upstream", "upstream", "main"])
    expect(pushR.success).toBe(true)

    const beforeHeadR = await gitStoreRun(gitR.data, ["rev-parse", "HEAD"])
    const beforeBranchR = await gitStoreRun(gitR.data, ["branch", "--show-current"])
    const beforeRemoteR = await gitStoreRun(gitR.data, ["config", "--get", "remote.upstream.url"])
    expect(beforeHeadR.success).toBe(true)
    expect(beforeBranchR.success).toBe(true)
    expect(beforeRemoteR.success).toBe(true)
    if (!beforeHeadR.success || !beforeBranchR.success || !beforeRemoteR.success) return

    const path = join(directory, "projects", "alice", "catalog.json")
    writeFileSync(path, `${JSON.stringify(project("catalog", 3010))}\n`, "utf8")
    writeFileSync(join(directory, "untracked.txt"), "dirty\n", "utf8")
    writeFileSync(join(directory, "projects", "alice", "untracked.json"), "{ invalid json\n", "utf8")
    writeFileSync(join(directory, ".gitignore"), "projects/alice/ignored.json\n", "utf8")
    writeFileSync(join(directory, "projects", "alice", "ignored.json"), "{ invalid json\n", "utf8")

    const readinessR = await openR.data.readiness()
    expect(readinessR.success).toBe(true)
    if (!readinessR.success) return
    expect(readinessR.data.ready).toBe(false)

    const readR = await openR.data.read()
    expect(readR.success).toBe(false)

    const recoverR = await openR.data.recover()
    expect(recoverR.success).toBe(true)
    if (!recoverR.success) return
    expect(recoverR.data.ready).toBe(true)
    expect(existsSync(join(directory, "projects", "alice", "untracked.json"))).toBe(false)
    expect(existsSync(join(directory, "projects", "alice", "ignored.json"))).toBe(false)
    expect(existsSync(join(directory, ".gitignore"))).toBe(false)

    const afterHeadR = await gitStoreRun(gitR.data, ["rev-parse", "HEAD"])
    const afterBranchR = await gitStoreRun(gitR.data, ["branch", "--show-current"])
    const afterRemoteR = await gitStoreRun(gitR.data, ["config", "--get", "remote.upstream.url"])
    expect(afterHeadR.success).toBe(true)
    expect(afterBranchR.success).toBe(true)
    expect(afterRemoteR.success).toBe(true)
    if (!afterHeadR.success || !afterBranchR.success || !afterRemoteR.success) return
    expect(afterHeadR.data.trim()).toBe(beforeHeadR.data.trim())
    expect(afterBranchR.data.trim()).toBe(beforeBranchR.data.trim())
    expect(afterRemoteR.data.trim()).toBe(beforeRemoteR.data.trim())

    const historyR = await openR.data.history({ owner: "alice", name: "catalog" })
    expect(historyR.success).toBe(true)
    if (!historyR.success) return
    expect(historyR.data).toHaveLength(1)

    const recoveredR = await openR.data.get({ owner: "alice", name: "catalog" })
    expect(recoveredR.success).toBe(true)
    if (!recoveredR.success) return
    expect(recoveredR.data.project.caddy?.port).toBe(3000)
  })

  test("rejects project divergence hidden by assume-unchanged and skip-worktree, then recovers it", async () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const directory = temporaryRepository()
      const openR = await projectRepositoryOpen({ dir: directory })
      expect(openR.success).toBe(true)
      if (!openR.success) return

      const createR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
      expect(createR.success).toBe(true)
      if (!createR.success) return

      const gitR = await gitStoreOpen({ dir: directory })
      expect(gitR.success).toBe(true)
      if (!gitR.success) return
      const projectPath = "projects/alice/catalog.json"
      const flagR = await gitStoreRun(gitR.data, ["update-index", flag, "--", projectPath])
      expect(flagR.success).toBe(true)
      writeFileSync(join(directory, projectPath), `${JSON.stringify(project("catalog", 3010))}\n`, "utf8")

      const statusR = await gitStoreRun(gitR.data, ["status", "--porcelain", "--untracked-files=all"])
      expect(statusR.success).toBe(true)
      if (!statusR.success) return
      expect(statusR.data.trim()).toBe("")

      const readinessR = await openR.data.readiness()
      expect(readinessR.success).toBe(true)
      if (!readinessR.success) return
      expect(readinessR.data).toMatchObject({ ready: false, clean: true })
      expect(readinessR.data.reason).toContain("tracked project file diverges from HEAD")

      const readR = await openR.data.read()
      expect(readR.success).toBe(false)
      if (readR.success) return
      expect(readR.errorMessage).toContain("tracked project file diverges from HEAD")

      const recoverR = await openR.data.recover()
      expect(recoverR.success).toBe(true)
      if (!recoverR.success) return
      expect(recoverR.data.ready).toBe(true)
      expect(JSON.parse(readFileSync(join(directory, projectPath), "utf8"))).toEqual(project("catalog", 3000))

      const flagsR = await gitStoreRun(gitR.data, ["ls-files", "-v", "--", projectPath])
      expect(flagsR.success).toBe(true)
      if (!flagsR.success) return
      expect(flagsR.data.trim().slice(0, 1)).toBe("H")
    }
  })

  test("edits and deletes flagged projects through real Git", async () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const directory = temporaryRepository()
      const openR = await projectRepositoryOpen({ dir: directory })
      expect(openR.success).toBe(true)
      if (!openR.success) return

      const createR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
      expect(createR.success).toBe(true)
      if (!createR.success) return

      const gitR = await gitStoreOpen({ dir: directory })
      expect(gitR.success).toBe(true)
      if (!gitR.success) return
      const projectPath = "projects/alice/catalog.json"

      const editFlagR = await gitStoreRun(gitR.data, ["update-index", flag, "--", projectPath])
      expect(editFlagR.success).toBe(true)
      if (!editFlagR.success) return

      const editR = await openR.data.edit({ owner: "alice", name: "catalog" }, project("catalog", 3001), {
        actor: "alice",
        expectedRevision: createR.data.revision,
      })
      expect(editR.success).toBe(true)
      if (!editR.success) return
      expect(JSON.parse(readFileSync(join(directory, projectPath), "utf8"))).toEqual(project("catalog", 3001))

      const deleteFlagR = await gitStoreRun(gitR.data, ["update-index", flag, "--", projectPath])
      expect(deleteFlagR.success).toBe(true)
      if (!deleteFlagR.success) return

      const deleteR = await openR.data.delete(
        { owner: "alice", name: "catalog" },
        { actor: "alice", expectedRevision: editR.data.revision },
      )
      expect(deleteR.success).toBe(true)
      if (!deleteR.success) return
      expect(existsSync(join(directory, projectPath))).toBe(false)
    }
  })

  test("rejects hidden divergence on a non-project tracked file, then recovers it", async () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const directory = temporaryRepository()
      const openR = await projectRepositoryOpen({ dir: directory })
      expect(openR.success).toBe(true)
      if (!openR.success) return

      const createR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
      expect(createR.success).toBe(true)
      if (!createR.success) return

      const gitR = await gitStoreOpen({ dir: directory })
      expect(gitR.success).toBe(true)
      if (!gitR.success) return
      const trackedPath = "README.md"
      writeFileSync(join(directory, trackedPath), "before\n", "utf8")
      const addR = await gitStoreRun(gitR.data, ["add", "--", trackedPath])
      expect(addR.success).toBe(true)
      if (!addR.success) return
      const commitR = await gitStoreRun(gitR.data, ["commit", "-m", "add tracked non-project file"])
      expect(commitR.success).toBe(true)
      if (!commitR.success) return

      const flagR = await gitStoreRun(gitR.data, ["update-index", flag, "--", trackedPath])
      expect(flagR.success).toBe(true)
      if (!flagR.success) return
      writeFileSync(join(directory, trackedPath), "after\n", "utf8")

      const statusR = await gitStoreRun(gitR.data, ["status", "--porcelain", "--untracked-files=all"])
      expect(statusR.success).toBe(true)
      if (!statusR.success) return
      expect(statusR.data.trim()).toBe("")

      const readinessR = await openR.data.readiness()
      expect(readinessR.success).toBe(true)
      if (!readinessR.success) return
      expect(readinessR.data).toMatchObject({ ready: false, clean: true })
      expect(readinessR.data.reason).toContain("tracked file diverges from HEAD")

      const recoverR = await openR.data.recover()
      expect(recoverR.success).toBe(true)
      if (!recoverR.success) return
      expect(recoverR.data.ready).toBe(true)
      expect(readFileSync(join(directory, trackedPath), "utf8")).toBe("before\n")

      const flagsR = await gitStoreRun(gitR.data, ["ls-files", "-v", "--", trackedPath])
      expect(flagsR.success).toBe(true)
      if (!flagsR.success) return
      expect(flagsR.data.trim().slice(0, 1)).toBe("H")
    }
  })

  test("rejects committed symlinks anywhere beneath projects", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const createR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
    expect(createR.success).toBe(true)
    if (!createR.success) return

    const outside = temporaryRepository()
    const target = join(outside, "outside.json")
    writeFileSync(target, "outside\n", "utf8")
    const link = join(directory, "projects", "alice", "linked.json")
    symlinkSync(target, link)

    const gitR = await gitStoreOpen({ dir: directory })
    expect(gitR.success).toBe(true)
    if (!gitR.success) return
    const addR = await gitStoreRun(gitR.data, ["add", "--", "projects/alice/linked.json"])
    expect(addR.success).toBe(true)
    const commitR = await gitStoreRun(gitR.data, ["commit", "-m", "add symlink"])
    expect(commitR.success).toBe(true)

    const readR = await openR.data.read()
    expect(readR.success).toBe(false)
    if (readR.success) return
    expect(readR.errorMessage).toContain("symbolic links")
  })

  test("rejects untracked symlink directories before reads or mutations", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const outside = temporaryRepository()
    const link = join(directory, "projects")
    symlinkSync(outside, link, "dir")

    const readR = await openR.data.read()
    expect(readR.success).toBe(false)
    if (readR.success) return
    expect(readR.errorMessage).toContain("symbolic links")

    const mutationR = await openR.data.create(project("catalog", 3000), { actor: "alice", expectedRevision: "" })
    expect(mutationR.success).toBe(false)
    if (mutationR.success) return
    expect(mutationR.errorMessage).toContain("symbolic links")

    const recoverR = await openR.data.recover()
    expect(recoverR.success).toBe(false)
    if (recoverR.success) return
    expect(recoverR.errorMessage).toContain("symbolic links")
  })

  test("does not write through a symlink outside the real worktree", async () => {
    const directory = temporaryRepository()
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const outside = temporaryRepository()
    symlinkSync(outside, join(directory, "projects"), "dir")
    const outsideProject = join(outside, "alice", "escape.json")

    const mutationR = await openR.data.create(project("escape", 3000), { actor: "alice", expectedRevision: "" })
    expect(mutationR.success).toBe(false)
    expect(existsSync(outsideProject)).toBe(false)
  })

  test("serializes mutations opened through real and symlink worktree aliases", async () => {
    const directory = temporaryRepository()
    const alias = `${directory}-alias`
    symlinkSync(directory, alias, "dir")
    directories.push(alias)

    const realR = await projectRepositoryOpen({ dir: directory })
    const aliasR = await projectRepositoryOpen({ dir: alias })
    expect(realR.success).toBe(true)
    expect(aliasR.success).toBe(true)
    if (!realR.success || !aliasR.success) return

    const changes = await Promise.all([
      realR.data.create(project("one", 3000), { actor: "alice", expectedRevision: "" }),
      aliasR.data.create(project("two", 3001), { actor: "alice", expectedRevision: "" }),
    ])
    expect(changes.filter((result) => result.success)).toHaveLength(1)

    const readR = await realR.data.read()
    expect(readR.success).toBe(true)
    if (!readR.success) return
    expect(readR.data.projects.map((item) => item.name)).toEqual(["one"])
  })
})
