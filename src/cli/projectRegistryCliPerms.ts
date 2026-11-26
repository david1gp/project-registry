import { lstat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import { sharedRootsOwnFilesRepair } from "../perms/sharedRootsOwnFilesRepair.js"
import { type SharedRootsPolicyEntry, sharedRootsPolicy } from "../perms/sharedRootsPolicy.js"

export type ProjectRegistryCliPermsResult = {
  applied: boolean
  checked: number
  /** Capped at 100 entries; repairedCount holds the full total. */
  repaired: string[]
  repairedCount: number
  targets: string[]
}

/** `perms` only manages the project-bearing roots, never /servers or /opensource. */
const permsManagedRootsDefault = ["/projects", "/adaptive"]

type PermsTarget = { root: string; projects: string[] }

function segmentValid(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0")
}

function outsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`)
}

/**
 * Repair the caller's own files under the shared project roots. This is a
 * local command (no daemon round-trip): agent umask 0077 turns bulk copies
 * from /tmp worktrees into group-inaccessible files, and only the owner can
 * fix their own bits without root. Dry-run by default; --apply repairs.
 */
export async function projectRegistryCliPerms(options: {
  project?: string
  all?: boolean
  apply?: boolean
  cwd?: string
  roots?: readonly SharedRootsPolicyEntry[]
  managedRoots?: readonly string[]
}): Promise<Result<ProjectRegistryCliPermsResult> & { hint?: string }> {
  const op = "projectRegistryCliPerms"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "Perms options are required")
  }
  const roots = options.roots ?? sharedRootsPolicy
  const managed = options.managedRoots ?? permsManagedRootsDefault
  const apply = options.apply === true

  if (options.all === true && options.project !== undefined) {
    return createResultError(op, "Pass either [project] or --all, not both.")
  }

  const managedRoots = roots.filter((entry) => managed.includes(entry.root))
  if (managedRoots.length === 0) return createResultError(op, "No perms-managed shared root is configured")

  const targets: PermsTarget[] = []
  if (options.all === true) {
    for (const entry of managedRoots) targets.push({ root: entry.root, projects: [] })
  } else if (options.project !== undefined) {
    if (!segmentValid(options.project)) return createResultError(op, "Project must be a top-level directory name")
    for (const entry of managedRoots) {
      const candidate = join(entry.root, options.project)
      try {
        if ((await lstat(candidate)).isDirectory()) targets.push({ root: entry.root, projects: [options.project] })
      } catch {
        continue // Absent under this root; the walk below reports when absent everywhere.
      }
    }
    if (targets.length === 0)
      return {
        ...createResultError(op, `No project directory named "${options.project}" under ${managed.join(" or ")}`),
        hint: "Run from inside the project directory, or pass --all.",
      }
  } else {
    const cwd = resolve(options.cwd ?? process.cwd())
    let scoped: PermsTarget | undefined
    for (const entry of managedRoots) {
      const relativeCwd = relative(entry.root, cwd)
      if (relativeCwd === "") {
        return {
          ...createResultError(op, `${cwd} is a shared root itself; pass [project] or --all`),
          hint: "Run from inside a project directory, or pass a project name.",
        }
      }
      if (relativeCwd.length === 0 || outsideRoot(relativeCwd) || isAbsolute(relativeCwd)) continue
      const name = relativeCwd.split(sep)[0]
      if (name === undefined || !segmentValid(name)) continue
      scoped = { root: entry.root, projects: [name] }
      break
    }
    if (scoped === undefined)
      return {
        ...createResultError(op, `Current directory is not under ${managed.join(" or ")}`),
        hint: "Run from inside a project directory, or pass [project] or --all.",
      }
    targets.push(scoped)
  }

  let checked = 0
  let repairedCount = 0
  const repaired: string[] = []
  const errors: string[] = []
  const rendered: string[] = []
  for (const target of targets) {
    const result = await sharedRootsOwnFilesRepair({
      roots,
      root: target.root,
      projects: target.projects,
      ...(apply ? { apply: true } : {}),
    })
    if (!result.success) return result
    checked += result.data.checked
    repairedCount += result.data.repairedCount
    for (const path of result.data.repaired) {
      if (repaired.length < 100) repaired.push(path)
    }
    errors.push(...result.data.errors)
    rendered.push(target.projects.length > 0 ? `${target.root}/${target.projects.join(",")}` : target.root)
  }
  if (apply && errors.length > 0)
    return createResultError(op, `${errors.length} path(s) could not be repaired: ${errors.slice(0, 3).join("; ")}`)
  return createResult({ applied: apply, checked, repairedCount, repaired, targets: rendered })
}
