import { constants, type Stats } from "node:fs"
import { open, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { createResult, createResultError, type PromiseResult } from "#result"
import { caddyProcessRun } from "../caddy/caddyProcessRun.js"

type Entry = { path: string; descriptor: string; directory: boolean; executable: boolean; stat: Stats; mountId: number }
type Handle = { fd: number; stat: () => Promise<Stats>; close: () => Promise<void> }

export type ProjectStaticAclRepairAdapter = {
  open: (path: string, flags: number) => Promise<Handle>
  mountId: (fd: number) => Promise<number>
  list: (descriptor: string) => Promise<string[]>
  run: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  verify: (fd: number, permission: "-r" | "-x") => Promise<void>
}

export type ProjectStaticAclRepairOptions = { caddyUser?: string }

const defaultAdapter: ProjectStaticAclRepairAdapter = {
  open: (path, flags) => open(path, flags),
  mountId: async (fd) => {
    // fdinfo describes the pinned descriptor, not a pathname that may be renamed.
    const match = /^mnt_id:\s*(\d+)\s*$/m.exec(await readFile(`/proc/self/fdinfo/${fd}`, "utf8"))
    if (!match) throw new Error("Linux descriptor mount ID is unavailable")
    return Number(match[1])
  },
  list: (descriptor) => readdir(descriptor),
  run: async (command, args) => {
    const result = await caddyProcessRun(command, args, "", { timeoutMs: 30_000 })
    if (!result.success) throw new Error(result.errorMessage)
    return result.data
  },
  verify: async (fd, permission) => {
    // Pass the pinned O_PATH descriptor as stdin: /proc/self/fd/0 belongs to the
    // unprivileged child, unlike /proc/<daemon-pid>/fd/<fd> (ptrace restricted).
    const child = Bun.spawn(["runuser", "-u", "caddy", "--", "test", permission, "/proc/self/fd/0"], {
      stdin: fd,
      stdout: "ignore",
      stderr: "pipe",
      signal: AbortSignal.timeout(30_000),
    })
    const stderr = new Response(child.stderr).text()
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`Caddy ${permission} verification failed: ${(await stderr).trim() || exitCode}`)
  },
}

// Linux O_PATH is not exported by Node's fs.constants (unlike O_NOFOLLOW).
const linuxOPath = 0o10000000

type Acl = Map<string, string>

function aclParse(output: string): Acl {
  const entries: Acl = new Map()
  for (const line of output.split("\n")) {
    if (!line || line.startsWith("#")) continue
    const match = /^(default:)?(user|group|mask|other):([^:]*):([r-][w-][x-])(?:\s+#effective:.*)?$/.exec(line)
    if (!match) throw new Error("unexpected getfacl output")
    const key = `${match[1] ?? ""}${match[2]}:${match[3] ?? ""}`
    if (entries.has(key)) throw new Error("duplicate ACL entry")
    entries.set(key, match[4]!)
  }
  for (const key of ["user:", "group:", "other:"]) {
    if (!entries.has(key)) throw new Error("incomplete access ACL")
  }
  return entries
}

function bits(value: string): number {
  return (value.includes("r") ? 4 : 0) | (value.includes("w") ? 2 : 0) | (value.includes("x") ? 1 : 0)
}

function mode(value: number): string {
  return `${value & 4 ? "r" : "-"}${value & 2 ? "w" : "-"}${value & 1 ? "x" : "-"}`
}

// A mask increase would otherwise silently widen every existing named principal and the owning group.
function aclChanges(before: Acl, desired: number, includeDefault: boolean): string[] {
  const changes: string[] = []
  for (const prefix of includeDefault ? ["", "default:"] : [""]) {
    const oldMask = bits(before.get(`${prefix}mask:`) ?? before.get(`${prefix}group:`) ?? "---")
    const caddyRights = desired | (bits(before.get(`${prefix}user:caddy`) ?? "---") & oldMask)
    const nextMask = oldMask | caddyRights
    for (const [key, value] of before) {
      if (!key.startsWith(prefix) || (prefix === "" && key.startsWith("default:"))) continue
      if (key === `${prefix}group:` || key.startsWith(`${prefix}group:`) || (key.startsWith(`${prefix}user:`) && key !== `${prefix}user:` && key !== `${prefix}user:caddy`)) {
        if (nextMask !== oldMask) changes.push(`${key}:${mode(bits(value) & oldMask)}`)
      }
    }
    if (prefix === "default:" && !before.has("default:user:")) {
      for (const kind of ["user:", "group:", "other:"]) changes.push(`default:${kind}:${before.get(kind)}`)
    }
    if (before.get(`${prefix}user:caddy`) !== mode(caddyRights)) changes.push(`${prefix}user:caddy:${mode(caddyRights)}`)
    // Supplying the mask explicitly avoids setfacl's automatic recalculation.
    if (before.get(`${prefix}mask:`) !== mode(nextMask)) changes.push(`${prefix}mask::${mode(nextMask)}`)
  }
  return changes
}

function aclEffective(acl: Acl, key: string): number {
  const prefix = key.startsWith("default:") ? "default:" : ""
  return bits(acl.get(key) ?? "---") & bits(acl.get(`${prefix}mask:`) ?? "rwx")
}

function aclVerify(before: Acl, after: Acl, desired: number, includeDefault: boolean): void {
  for (const prefix of includeDefault ? ["", "default:"] : [""]) {
    if ((aclEffective(after, `${prefix}user:caddy`) & desired) !== desired) throw new Error("Caddy ACL is masked")
  }
  for (const [key, value] of before) {
    if (key.endsWith("mask:")) continue
    const wasMasked = key === "group:" || key.endsWith("group:") || /^(?:default:)?(?:user|group):[^:]+$/.test(key)
    const oldRights = wasMasked ? aclEffective(before, key) : bits(value)
    const newRights = wasMasked ? aclEffective(after, key) : bits(after.get(key) ?? "---")
    if (key === "user:caddy" || key === "default:user:caddy") {
      if ((newRights & oldRights) !== oldRights) throw new Error("existing Caddy ACL rights changed")
      continue
    }
    if (oldRights !== newRights) throw new Error(`existing ACL rights changed: ${key}`)
  }
}

function rootParts(owner: string, root: string): string[] {
  // Match the authorized project owner pattern (CLI and API), while excluding path segments.
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(owner) || owner === "." || owner === "..") throw new Error("invalid owner")
  if (!root.startsWith("/") || root.includes("\0") || root.includes("//") || root.endsWith("/")) throw new Error("invalid static root")
  const parts = root.slice(1).split("/")
  if (parts.some((part) => part === "." || part === ".." || !part)) throw new Error("invalid static root")
  if (parts[0] !== "home" || parts[1] !== owner) throw new Error("root does not belong to owner")
  if (parts[2] === "projects" && parts.length > 3) return parts
  if (parts[2] === "wiki" && parts.length >= 3) return parts
  throw new Error("static root outside owner projects/wiki")
}

/** Repairs only an owner-scoped static root. The caller must authorize the project and derive the root server-side. */
export async function projectStaticAclRepair(
  owner: string,
  root: string,
  adapter: ProjectStaticAclRepairAdapter = defaultAdapter,
  options: ProjectStaticAclRepairOptions = {},
): PromiseResult<{ root: string; entries: number; skipped?: "caddy-root" }> {
  const op = "projectStaticAclRepair"
  if (options.caddyUser === "root" || options.caddyUser === "0") {
    try {
      rootParts(owner, root)
      return createResult({ root, entries: 0, skipped: "caddy-root" })
    } catch (error) {
      return createResultError(op, error instanceof Error ? error.message : "invalid static root", root)
    }
  }
  if (options.caddyUser !== undefined && options.caddyUser !== "caddy") {
    return createResultError(op, `unsupported Caddy identity for ACL repair: ${options.caddyUser}; supported non-root identity is caddy`)
  }
  let handle: Handle | undefined
  const openedHandles: Handle[] = []
  let aclMutationAttempted = false
  try {
    if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
      return createResultError(op, "secure Linux descriptor traversal is unavailable")
    }
    const parts = rootParts(owner, root)
    const opened: { entry: Entry; handle: Handle }[] = []
    const flags = linuxOPath | constants.O_NOFOLLOW
    handle = await adapter.open("/", flags | constants.O_DIRECTORY)
    const filesystemMount = await adapter.mountId(handle.fd)
    const filesystemRoot: Entry = { path: "/", descriptor: `/proc/${process.pid}/fd/${handle.fd}`, directory: true, executable: true, stat: await handle.stat(), mountId: filesystemMount }
    let parent = handle
    let current = ""
    for (let i = 0; i < parts.length; i++) {
      const path = join(current || "/", parts[i]!)
      // /proc/self/fd pins the parent directory even if a pathname is swapped during traversal.
      const child = await adapter.open(`/proc/self/fd/${parent.fd}/${parts[i]}`, flags)
      openedHandles.push(child)
      const stat = await child.stat()
      const mountId = await adapter.mountId(child.fd)
      if (mountId !== filesystemMount) throw new Error(`mount crossing: ${path}`)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (i !== parts.length - 1 || !stat.isFile()))) {
        throw new Error(`unsafe path component: ${path}`)
      }
      parent = child
      current = path
      opened.push({ entry: { path, descriptor: `/proc/${process.pid}/fd/${child.fd}`, directory: stat.isDirectory(), executable: (stat.mode & 0o111) !== 0, stat, mountId }, handle: child })
    }
    // Keep the root descriptor open until all descendants have been processed.
    const rootHandle = parent
    const rootEntry = opened.at(-1)!.entry
    if (!rootEntry.directory) throw new Error("static root must be a directory")

    async function run(command: string, args: string[]): Promise<string> {
      const result = await adapter.run(command, args)
      if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || result.exitCode}`)
      return result.stdout
    }

    // Check that the served pathname still reaches the pinned inode, not a
    // replacement (including a swapped ancestor). Never follow a symlink.
    async function checkPath(entry: Entry): Promise<void> {
      let parent = await adapter.open("/", flags | constants.O_DIRECTORY)
      try {
        if (await adapter.mountId(parent.fd) !== filesystemMount) throw new Error(`static path changed: ${entry.path}`)
        for (const part of entry.path === "/" ? [] : entry.path.slice(1).split("/")) {
          const child = await adapter.open(`/proc/self/fd/${parent.fd}/${part}`, flags)
          await parent.close()
          parent = child
          const stat = await child.stat()
          if (stat.isSymbolicLink() || await adapter.mountId(child.fd) !== filesystemMount) throw new Error(`static path changed: ${entry.path}`)
        }
        const stat = await parent.stat()
        if (stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino || await adapter.mountId(parent.fd) !== entry.mountId) throw new Error(`static path changed: ${entry.path}`)
      } finally {
        await parent.close()
      }
    }

    async function repair(entry: Entry, pinned: Handle, desired: number, defaults: boolean): Promise<void> {
      // Reject stale pinned inodes before either read or mutation, as well as after.
      await checkPath(entry)
      const before = aclParse(await run("getfacl", ["--absolute-names", "--omit-header", "--", entry.descriptor]))
      const changes = aclChanges(before, desired, defaults)
      if (changes.length) await checkPath(entry)
      let changed = false
      try {
        if (changes.length) {
          changed = true
          aclMutationAttempted = true
          await run("setfacl", ["--no-mask", "--modify", changes.join(","), "--", entry.descriptor])
          await checkPath(entry)
        }
        const after = aclParse(await run("getfacl", ["--absolute-names", "--omit-header", "--", entry.descriptor]))
        aclVerify(before, after, desired, defaults)
        await adapter.verify(pinned.fd, entry.directory ? "-x" : "-r")
        if (entry.directory && defaults) await adapter.verify(pinned.fd, "-r")
        if (!entry.directory && entry.executable) await adapter.verify(pinned.fd, "-x")
        await checkPath(entry)
      } catch (error) {
        if (changed) {
          try {
            // A rename between the last check and setfacl cannot be made atomic with
            // external ACL tools. Best-effort restore prevents a persistent off-root grant.
            await run("setfacl", ["--no-mask", "--set", [...before].map(([key, value]) => `${key}:${value}`).join(","), "--", entry.descriptor])
            const restored = aclParse(await run("getfacl", ["--absolute-names", "--omit-header", "--", entry.descriptor]))
            if (restored.size !== before.size || [...before].some(([key, value]) => restored.get(key) !== value)) {
              throw new Error("ACL rollback verification failed")
            }
          } catch (rollbackError) {
            throw new Error(`${error instanceof Error ? error.message : error}; ACL rollback failed: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`)
          }
        }
        throw error
      }
    }

    // Avoid touching shared / and /home when Caddy already has traversal.
    try {
      await adapter.verify(handle.fd, "-x")
      await checkPath(filesystemRoot)
    } catch {
      await repair(filesystemRoot, handle, 1, false)
    }
    for (const { entry, handle: pinned } of opened.slice(0, -1)) {
      if (entry.path === "/home") {
        try {
          await adapter.verify(pinned.fd, "-x")
          await checkPath(entry)
          continue
        } catch {
          // A failed check is repaired (and then verified) below.
        }
      }
      await repair(entry, pinned, 1, false)
    }

    let count = 0
    async function walk(entry: Entry, pinned: Handle): Promise<void> {
      await repair(entry, pinned, entry.directory ? 5 : entry.executable ? 5 : 4, entry.directory)
      count++
      if (!entry.directory) return
      for (const name of await adapter.list(entry.descriptor)) {
        if (name === "." || name === ".." || name.includes("/")) throw new Error("invalid directory entry")
        const child = await adapter.open(`/proc/self/fd/${pinned.fd}/${name}`, flags)
        try {
          const stat = await child.stat()
          const mountId = await adapter.mountId(child.fd)
          if (mountId !== filesystemMount) throw new Error(`mount crossing: ${join(entry.path, name)}`)
          // Symlinks are deliberately never traversed or modified.
          if (stat.isSymbolicLink()) continue
          if (!stat.isDirectory() && !stat.isFile()) throw new Error(`unsupported static entry: ${join(entry.path, name)}`)
          // A file with another hardlink might also be served outside this root.
          if (stat.isFile() && stat.nlink !== 1) throw new Error(`hardlinked static entry: ${join(entry.path, name)}`)
          await walk({ path: join(entry.path, name), descriptor: `/proc/${process.pid}/fd/${child.fd}`, directory: stat.isDirectory(), executable: (stat.mode & 0o111) !== 0, stat, mountId }, child)
        } finally {
          await child.close()
        }
      }
    }
    await walk(rootEntry, rootHandle)
    return createResult({ root, entries: count })
  } catch (error) {
    const message = error instanceof Error ? error.message : "ACL repair failed"
    return createResultError(op, aclMutationAttempted ? `Partial ACL repair may have occurred: ${message}` : message, root)
  } finally {
    // Keep all ancestor descriptors pinned during the complete traversal.
    for (const child of openedHandles) await child.close()
    if (handle) await handle.close()
  }
}
