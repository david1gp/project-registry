import { expect, test } from "bun:test"
import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sharedRootsOwnFilesRepair } from "./sharedRootsOwnFilesRepair.js"

const memberGroups = Bun.spawnSync(["id", "-Gn"]).stdout.toString().trim().split(/\s+/).filter(Boolean)
const primaryGroup = Bun.spawnSync(["id", "-gn"]).stdout.toString().trim()
const otherGroup = memberGroups.find((group) => group !== primaryGroup)
if (!otherGroup) throw new Error("Test needs a second group membership (this box grants several)")

const groupIdOf = (group: string): number => {
  const entry = Bun.spawnSync(["getent", "group", group]).stdout.toString().split(":")[2]
  const gid = Number(entry)
  if (!Number.isInteger(gid)) throw new Error(`Cannot resolve group ${group}`)
  return gid
}

type Fixture = { root: string; cleanup: () => void }

function fixtureRootCreate(): Fixture {
  const root = join(tmpdir(), `own-repair-fixture-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  // Private group-less file, owner-executable file, group-less dir with nested file.
  writeFileSync(join(root, "plain.txt"), "fixture")
  chmodSync(join(root, "plain.txt"), 0o600)
  writeFileSync(join(root, "run.sh"), "fixture")
  chmodSync(join(root, "run.sh"), 0o700)
  mkdirSync(join(root, "sub"))
  chmodSync(join(root, "sub"), 0o700)
  writeFileSync(join(root, "sub", "nested.txt"), "fixture")
  chmodSync(join(root, "sub", "nested.txt"), 0o600)
  // Already conforming, private key, project git objects, and a symlink: all must be left alone.
  writeFileSync(join(root, "ok.txt"), "fixture")
  chmodSync(join(root, "ok.txt"), 0o664)
  writeFileSync(join(root, "id_ed25519"), "fixture")
  chmodSync(join(root, "id_ed25519"), 0o600)
  mkdirSync(join(root, ".git", "objects"), { recursive: true })
  writeFileSync(join(root, ".git", "objects", "pack"), "fixture")
  chmodSync(join(root, ".git", "objects", "pack"), 0o600)
  symlinkSync(join(root, "plain.txt"), join(root, "link.txt"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const modeOf = (path: string): number => lstatSync(path).mode & 0o7777

test("check reports repairs without changing anything", async () => {
  const fixture = fixtureRootCreate()
  try {
    const before = modeOf(join(fixture.root, "plain.txt"))
    const result = await sharedRootsOwnFilesRepair({ roots: [{ root: fixture.root, group: primaryGroup }] })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.repairedCount).toBe(4)
    expect(modeOf(join(fixture.root, "plain.txt"))).toBe(before)
  } finally {
    fixture.cleanup()
  }
})

test("apply adds group access and setgid while preserving other bits and skipping keys, git and links", async () => {
  const fixture = fixtureRootCreate()
  try {
    const result = await sharedRootsOwnFilesRepair({
      roots: [{ root: fixture.root, group: primaryGroup }],
      apply: true,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.repairedCount).toBe(4)
    expect(result.data.errors).toEqual([])
    expect(modeOf(join(fixture.root, "plain.txt"))).toBe(0o660)
    expect(modeOf(join(fixture.root, "run.sh"))).toBe(0o770)
    expect(modeOf(join(fixture.root, "sub"))).toBe(0o2750)
    expect(modeOf(join(fixture.root, "sub", "nested.txt"))).toBe(0o660)
    expect(modeOf(join(fixture.root, "ok.txt"))).toBe(0o664)
    expect(modeOf(join(fixture.root, "id_ed25519"))).toBe(0o600)
    expect(modeOf(join(fixture.root, ".git", "objects", "pack"))).toBe(0o600)
    expect(lstatSync(join(fixture.root, "link.txt")).isSymbolicLink()).toBe(true)
    const again = await sharedRootsOwnFilesRepair({
      roots: [{ root: fixture.root, group: primaryGroup }],
      apply: true,
    })
    expect(again.success).toBe(true)
    if (!again.success) return
    expect(again.data.repairedCount).toBe(0)
  } finally {
    fixture.cleanup()
  }
})

test("apply reassigns the shared group on owned files even when modes already conform", async () => {
  const fixture = fixtureRootCreate()
  try {
    const check = await sharedRootsOwnFilesRepair({ roots: [{ root: fixture.root, group: otherGroup }] })
    expect(check.success).toBe(true)
    if (!check.success) return
    expect(check.data.repairedCount).toBeGreaterThan(0)
    const applied = await sharedRootsOwnFilesRepair({
      roots: [{ root: fixture.root, group: otherGroup }],
      apply: true,
    })
    expect(applied.success).toBe(true)
    if (!applied.success) return
    expect(applied.data.errors).toEqual([])
    const gid = groupIdOf(otherGroup)
    for (const name of ["plain.txt", "ok.txt", join("sub", "nested.txt")])
      expect(lstatSync(join(fixture.root, name)).gid).toBe(gid)
  } finally {
    fixture.cleanup()
  }
})

test("leaves hard links shared with another policy group to the hourly reconciler", async () => {
  const first = fixtureRootCreate()
  const second = fixtureRootCreate()
  try {
    const shared = join(first.root, "plain.txt")
    linkSync(shared, join(first.root, "plain-hardlink.txt"))
    const check = await sharedRootsOwnFilesRepair({
      roots: [
        { root: first.root, group: otherGroup },
        { root: second.root, group: primaryGroup },
      ],
    })
    expect(check.success).toBe(true)
    if (!check.success) return
    expect(check.data.repaired).not.toContain(shared)
    const applied = await sharedRootsOwnFilesRepair({
      roots: [
        { root: first.root, group: otherGroup },
        { root: second.root, group: primaryGroup },
      ],
      apply: true,
    })
    expect(applied.success).toBe(true)
    if (!applied.success) return
    expect(modeOf(shared)).toBe(0o600)
    expect(lstatSync(shared).gid).toBe(groupIdOf(primaryGroup))
  } finally {
    first.cleanup()
    second.cleanup()
  }
})

test("rejects unknown groups, roots and project escapes", async () => {
  const fixture = fixtureRootCreate()
  try {
    const roots = [{ root: fixture.root, group: primaryGroup }]
    expect((await sharedRootsOwnFilesRepair({ roots, root: "/home/leo" })).success).toBe(false)
    expect(
      (await sharedRootsOwnFilesRepair({ roots: [{ root: fixture.root, group: "group-that-cannot-exist" }] })).success,
    ).toBe(false)
    expect((await sharedRootsOwnFilesRepair({ roots, projects: ["../bad"] })).success).toBe(false)
    expect((await sharedRootsOwnFilesRepair({ roots, projects: ["missing"] })).success).toBe(false)
    expect(readdirSync(fixture.root).length).toBeGreaterThan(0)
  } finally {
    fixture.cleanup()
  }
})
