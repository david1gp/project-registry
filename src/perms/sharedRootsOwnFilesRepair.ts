// Repairs the caller's own files under the shared roots without root: group
// ownership drift (e.g. bulk copies from /tmp worktrees land in the creator's
// private group with umask 0077 modes) and missing group read/write bits break
// every other member's `bun install`. Additive only: group bits are added and
// the group is assigned, other bits are never stripped, symlinks are never
// followed, and private keys plus project `.git` contents are never touched.
// The hourly root reconciler owns default-ACL policy; this only converges the
// bits an owner can fix immediately. Second run repairs zero (idempotent).
import { chmod, chown, lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { createResult, createResultError } from "#result"
import { sharedRootsPolicy } from "./sharedRootsPolicy.js"

export type SharedRootsOwnFilesRepairOptions = {
  /** Defaults to sharedRootsPolicy. Tests inject a tmp root with the caller's primary group. */
  roots?: readonly { root: string; group: string }[]
  /** Must be one of the configured roots. */
  root?: string
  /** Restrict to top-level directory names (defaults to /projects scope when root is unset). */
  projects?: readonly string[]
  /** False (default) reports without changing anything. */
  apply?: boolean
}

export type SharedRootsOwnFilesRepairData = {
  checked: number
  /** Capped at 100 entries; repairedCount holds the full total. */
  repaired: string[]
  repairedCount: number
  errors: string[]
}

// Mirrors private_key() in sharedRootsReconcile.py: never chmod/chgrp key material.
const privateKeyNameTest = (name: string): boolean => {
  if (name.startsWith("id_") && !name.endsWith(".pub")) return true
  return /\.pem$/.test(name) || /\.key$/.test(name) || /_key$/.test(name) || /\.p12$/.test(name) || /\.pfx$/.test(name)
}

const groupIdRead = (group: string): number | undefined => {
  const found = Bun.spawnSync(["getent", "group", group])
  if (!found.success || found.exitCode !== 0) return undefined
  const gid = Number(found.stdout.toString().split(":")[2])
  return Number.isInteger(gid) ? gid : undefined
}

export async function sharedRootsOwnFilesRepair(
  options: SharedRootsOwnFilesRepairOptions = {},
): Promise<
  { success: true; data: SharedRootsOwnFilesRepairData } | { success: false; op: string; errorMessage: string }
> {
  const op = "sharedRootsOwnFilesRepair"
  const roots = options.roots ?? sharedRootsPolicy
  if (options.root !== undefined && !roots.some((entry) => entry.root === options.root))
    return createResultError(op, "Root must be one of the configured shared roots")
  const projects = options.projects ?? []
  if (projects.some((name) => !name || name === "." || name === ".." || name.includes("/") || name.includes("\0")))
    return createResultError(op, "Project names must be top-level directory names")
  const selected = options.root ?? (projects.length > 0 ? "/projects" : undefined)
  const scoped = selected ? roots.filter((entry) => entry.root === selected) : roots
  if (scoped.length === 0) return createResultError(op, "Root must be one of the configured shared roots")
  if (typeof process.getuid !== "function") return createResultError(op, "Cannot determine caller uid")
  const uid = process.getuid()

  const data: SharedRootsOwnFilesRepairData = { checked: 0, repaired: [], repairedCount: 0, errors: [] }
  const recordRepaired = (path: string): void => {
    data.repairedCount += 1
    if (data.repaired.length < 100) data.repaired.push(path)
  }
  const recordError = (path: string, error: unknown): void => {
    data.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const repairPath = async (path: string, gid: number, inNodeModules: boolean): Promise<void> => {
    let info
    try {
      info = await lstat(path)
    } catch {
      return // Builds/Git can remove entries during a sweep.
    }
    if (info.isSymbolicLink()) return // Never follow or retarget links.
    if (info.uid !== uid) return // Other owners are the hourly reconciler's job.
    // Mirrors shared_inode() in sharedRootsReconcile.py: a hard link shared with
    // another root keeps its current policy group (the reconciler grants this
    // root a named ACL entry instead). Re-grouping here would revoke the other
    // root's group access until the next hourly pass.
    if (info.isFile() && info.nlink > 1 && info.gid !== gid && policyGids.has(info.gid)) return
    data.checked += 1
    if (!info.isDirectory() && !info.isFile()) return
    const base = path.split("/").at(-1) ?? ""
    if (!info.isDirectory() && privateKeyNameTest(base)) return
    if (info.isDirectory()) {
      if (!inNodeModules && base === ".git") return // Git keeps its own objects group read-only.
      const nextModules = inNodeModules || base === "node_modules"
      let entries
      try {
        entries = await readdir(path)
      } catch (error) {
        recordError(path, error)
        return
      }
      for (const entry of entries) await repairPath(join(path, entry), gid, nextModules)
    } else if (!inNodeModules && path.includes("/.git/")) {
      return // Project git objects stay group read-only (reconciler strips g+w there).
    }
    const current = info.mode & 0o7777
    const target = info.isDirectory()
      ? current | 0o2750 // setgid + group rwx (group rx minimum for traversal).
      : current | 0o060 | (info.mode & 0o100 ? 0o010 : 0) // g+rw, g+x only where owner-x exists.
    if (target === current && info.gid === gid) return
    if (!options.apply) {
      recordRepaired(path)
      return
    }
    try {
      if (info.gid !== gid) await chown(path, -1, gid)
      if (target !== current) await chmod(path, target)
      recordRepaired(path)
    } catch (error) {
      recordError(path, error)
    }
  }

  const policyGids = new Set<number>()
  for (const entry of roots) {
    const gid = groupIdRead(entry.group)
    if (gid !== undefined) policyGids.add(gid)
  }
  const targets: { root: string; gid: number }[] = []
  for (const entry of scoped) {
    const gid = groupIdRead(entry.group)
    if (gid === undefined) return createResultError(op, `Unknown group: ${entry.group}`)
    policyGids.add(gid)
    targets.push({ root: entry.root, gid })
  }

  for (const { root, gid } of targets) {
    const starts = projects.length > 0 ? projects.map((name) => join(root, name)) : [root]
    for (const start of starts) {
      let info
      try {
        info = await lstat(start)
      } catch (error) {
        return createResultError(
          op,
          `Cannot inspect ${start}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (info.isSymbolicLink()) return createResultError(op, `Start is a symlink: ${start}`)
      if (start !== root) {
        if (!info.isDirectory()) return createResultError(op, `Not a project directory: ${start}`)
        await repairPath(start, gid, false)
        continue
      }
      let names
      try {
        names = await readdir(start)
      } catch (error) {
        return createResultError(op, `Cannot list ${start}: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const name of names) await repairPath(join(start, name), gid, name === "node_modules")
    }
  }
  if (options.apply && data.errors.length > 0)
    return createResultError(
      op,
      `${data.errors.length} path(s) could not be repaired: ${data.errors.slice(0, 3).join("; ")}`,
    )
  return createResult(data)
}
