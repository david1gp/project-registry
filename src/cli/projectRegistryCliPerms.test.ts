import { describe, expect, test } from "bun:test"
import { lstatSync } from "node:fs"
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectRegistryCliPerms } from "./projectRegistryCliPerms.js"
import { projectRegistryCliRun } from "./projectRegistryCliRun.js"

const primaryGroup = Bun.spawnSync(["id", "-gn"]).stdout.toString().trim()

type Fixture = {
  rootA: string
  rootB: string
  roots: { root: string; group: string }[]
  managedRoots: string[]
  cleanup: () => Promise<void>
}

async function fixtureCreate(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "registry-perms-"))
  const rootA = join(base, "projects")
  const rootB = join(base, "adaptive")
  await mkdir(join(rootA, "site-a", "sub"), { recursive: true })
  await mkdir(join(rootB, "site-b"), { recursive: true })
  // site-a needs four repairs: two files, one owner-executable, one directory.
  await writeFile(join(rootA, "site-a", "plain.txt"), "fixture")
  await chmod(join(rootA, "site-a", "plain.txt"), 0o600)
  await writeFile(join(rootA, "site-a", "run.sh"), "fixture")
  await chmod(join(rootA, "site-a", "run.sh"), 0o700)
  await chmod(join(rootA, "site-a", "sub"), 0o700)
  await writeFile(join(rootA, "site-a", "sub", "nested.txt"), "fixture")
  await chmod(join(rootA, "site-a", "sub", "nested.txt"), 0o600)
  // site-b needs one repair.
  await writeFile(join(rootB, "site-b", "plain.txt"), "fixture")
  await chmod(join(rootB, "site-b", "plain.txt"), 0o600)
  const roots = [
    { root: rootA, group: primaryGroup },
    { root: rootB, group: primaryGroup },
  ]
  return {
    rootA,
    rootB,
    roots,
    managedRoots: [rootA, rootB],
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

describe("projectRegistryCliPerms", () => {
  test("resolves the project of the current directory without changing anything", async () => {
    const fixture = await fixtureCreate()
    try {
      const result = await projectRegistryCliPerms({
        cwd: join(fixture.rootA, "site-a", "sub"),
        roots: fixture.roots,
        managedRoots: fixture.managedRoots,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.applied).toBe(false)
      expect(result.data.targets).toEqual([join(fixture.rootA, "site-a")])
      expect(result.data.repairedCount).toBe(5)
      expect(lstatSync(join(fixture.rootA, "site-a", "plain.txt")).mode & 0o7777).toBe(0o600)
    } finally {
      await fixture.cleanup()
    }
  })

  test("finds an explicit project under any managed root and repairs it with --apply", async () => {
    const fixture = await fixtureCreate()
    try {
      const dry = await projectRegistryCliPerms({
        project: "site-b",
        roots: fixture.roots,
        managedRoots: fixture.managedRoots,
      })
      expect(dry.success).toBe(true)
      if (!dry.success) return
      expect(dry.data.targets).toEqual([join(fixture.rootB, "site-b")])
      expect(dry.data.repairedCount).toBe(2)
      const applied = await projectRegistryCliPerms({
        project: "site-b",
        apply: true,
        roots: fixture.roots,
        managedRoots: fixture.managedRoots,
      })
      expect(applied.success).toBe(true)
      if (!applied.success) return
      expect(applied.data.applied).toBe(true)
      expect(applied.data.repairedCount).toBe(2)
      expect(lstatSync(join(fixture.rootB, "site-b", "plain.txt")).mode & 0o7777).toBe(0o660)
      const again = await projectRegistryCliPerms({
        project: "site-b",
        roots: fixture.roots,
        managedRoots: fixture.managedRoots,
      })
      expect(again.success).toBe(true)
      if (!again.success) return
      expect(again.data.repairedCount).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })

  test("covers every managed root with --all", async () => {
    const fixture = await fixtureCreate()
    try {
      const result = await projectRegistryCliPerms({
        all: true,
        roots: fixture.roots,
        managedRoots: fixture.managedRoots,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.targets).toEqual([fixture.rootA, fixture.rootB])
      expect(result.data.repairedCount).toBe(7)
    } finally {
      await fixture.cleanup()
    }
  })

  test("rejects a bare shared root, foreign directories, unknown projects and project with --all", async () => {
    const fixture = await fixtureCreate()
    try {
      const scope = { roots: fixture.roots, managedRoots: fixture.managedRoots }
      const bare = await projectRegistryCliPerms({ cwd: fixture.rootA, ...scope })
      expect(bare.success).toBe(false)
      if (bare.success) return
      expect(bare.errorMessage).toContain("--all")
      const foreign = await projectRegistryCliPerms({ cwd: tmpdir(), ...scope })
      expect(foreign.success).toBe(false)
      if (foreign.success) return
      expect(foreign.errorMessage).toContain("not under")
      const missing = await projectRegistryCliPerms({ project: "no-such-site", ...scope })
      expect(missing.success).toBe(false)
      if (missing.success) return
      expect(missing.errorMessage).toContain("no-such-site")
      const conflict = await projectRegistryCliPerms({ project: "site-a", all: true, ...scope })
      expect(conflict.success).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test("runs end to end through the CLI with counts, JSON and pending-repair exit status", async () => {
    const fixture = await fixtureCreate()
    try {
      const run = async (args: readonly string[]) => {
        const stdout: string[] = []
        const stderr: string[] = []
        const exitCode = await projectRegistryCliRun(args, {
          environment: { USER: "david" },
          stdout: (text: string) => stdout.push(text),
          stderr: (text: string) => stderr.push(text),
          permsCwd: () => join(fixture.rootA, "site-a"),
          permsRoots: fixture.roots,
          permsManagedRoots: fixture.managedRoots,
        })
        return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") }
      }
      const dry = await run(["perms"])
      expect(dry.exitCode).toBe(1)
      expect(dry.stdout).toContain("Would repair 5 of")
      expect(dry.stdout).toContain("needs repair")
      const applied = await run(["perms", "--apply"])
      expect(applied.exitCode).toBe(0)
      expect(applied.stdout).toContain("Repaired 5 of")
      const clean = await run(["perms", "--json"])
      expect(clean.exitCode).toBe(0)
      expect(JSON.parse(clean.stdout)).toMatchObject({ success: true, data: { repairedCount: 0 } })
      const missing = await run(["perms", "no-such-site"])
      expect(missing.exitCode).toBe(1)
      expect(missing.stderr).toContain("no-such-site")
    } finally {
      await fixture.cleanup()
    }
  })
})
