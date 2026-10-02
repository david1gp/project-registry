import { describe, expect, test } from "bun:test"
import { constants } from "node:fs"
import { projectStaticAclRepair, type ProjectStaticAclRepairAdapter } from "./projectStaticAclRepair.js"

type Node = { kind: "directory" | "file" | "symlink"; mode: number; ino: number; nlink: number; mountId: number; children?: string[]; acl: Map<string, string> }

function fixture() {
  const nodes = new Map<string, Node>()
  let nextFd = 10
  let nextIno = 1
  const handles = new Map<number, string>()
  const pinned = new Map<number, Node>()
  const calls: { command: string; args: string[] }[] = []
  let fail: string | undefined
  let verifyFailure = false
  const basic = () => new Map([["user:", "rwx"], ["group:", "r-x"], ["other:", "---"]])
  function add(path: string, kind: Node["kind"] = "directory", mode = 0o755) {
    nodes.set(path, { kind, mode, ino: nextIno++, nlink: 1, mountId: 1, children: [], acl: basic() })
    if (path !== "/") nodes.get(path.slice(0, path.lastIndexOf("/")) || "/")?.children?.push(path.split("/").at(-1)!)
    return nodes.get(path)!
  }
  add("/")
  add("/home")
  add("/home/ada")
  add("/home/ada/projects")
  add("/home/ada/projects/site")
  add("/home/ada/projects/site/dist")
  add("/home/ada/projects/site/dist/nested")
  add("/home/ada/projects/site/dist/nested/page.html", "file", 0o644)
  add("/home/ada/projects/site/dist/link", "symlink")
  const descriptorPath = (value: string): string => {
    const match = /^\/proc\/(?:self|\d+)\/fd\/(\d+)(.*)$/.exec(value)
    if (!match) return value
    const parent = handles.get(Number(match[1]))
    if (!parent) throw new Error("descriptor closed")
    if (!match[2]) return parent
    return `${parent === "/" ? "" : parent}${match[2]}`
  }
  const adapter: ProjectStaticAclRepairAdapter = {
    mountId: async (fd) => pinned.get(fd)!.mountId,
    open: async (path, flags) => {
      expect(flags & constants.O_NOFOLLOW).toBeTruthy()
      const resolved = descriptorPath(path)
      const node = nodes.get(resolved)
      if (!node) throw new Error(`missing: ${resolved}`)
      const fd = nextFd++
      handles.set(fd, resolved)
      pinned.set(fd, node)
      return {
        fd,
        stat: async () => ({
          isDirectory: () => node.kind === "directory",
          isFile: () => node.kind === "file",
          isSymbolicLink: () => node.kind === "symlink",
          mode: node.mode,
          ino: node.ino,
          dev: 1,
          nlink: node.nlink,
        }) as never,
        close: async () => { handles.delete(fd); pinned.delete(fd) },
      }
    },
    list: async (descriptor) => [...(nodes.get(descriptorPath(descriptor))?.children ?? [])],
    run: async (command, args) => {
      calls.push({ command, args })
      if (fail === command) return { exitCode: 1, stdout: "", stderr: "denied" }
      const target = args.at(-1)!
      const descriptor = /^\/proc\/(?:self|\d+)\/fd\/(\d+)$/.exec(target)
      const path = descriptorPath(target)
      const node = descriptor ? pinned.get(Number(descriptor[1])) : nodes.get(path)
      if (!node) throw new Error(`missing: ${path}`)
      if (command === "getfacl") {
        return { exitCode: 0, stdout: `${[...node.acl].map(([key, value]) => `${key}:${value}`).join("\n")}\n`, stderr: "" }
      }
      if (command === "setfacl") {
        expect(args).toContain("--no-mask")
        if (args.includes("--set")) node.acl = new Map()
        for (const change of args[args.indexOf(args.includes("--set") ? "--set" : "--modify") + 1]!.split(",")) {
          const match = /^(.*):([r-][w-][x-])$/.exec(change)!
          node.acl.set(match[1]!, match[2]!)
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      throw new Error(`unexpected command: ${command}`)
    },
    verify: async (fd, permission) => {
      if (verifyFailure) throw new Error("Caddy verification failed")
      const node = pinned.get(fd)!
      const named = node.acl.get("user:caddy")
      const mask = node.acl.get("mask:") ?? "rwx"
      const allowed = named === undefined ? node.acl.get("other:")! : [...named].filter((right) => mask.includes(right)).join("")
      if (!allowed.includes(permission.slice(1))) throw new Error("Caddy verification failed")
    },
  }
  return { nodes, calls, adapter, failWith(command: string) { fail = command }, failVerification() { verifyFailure = true } }
}

describe("projectStaticAclRepair", () => {
  test("root Caddy identity succeeds without inspecting paths or invoking ACL tools", async () => {
    const f = fixture()
    const calls: string[] = []
    const adapter: ProjectStaticAclRepairAdapter = {
      open: async () => { calls.push("open"); throw new Error("unexpected open") },
      mountId: async () => { calls.push("mountId"); throw new Error("unexpected mountId") },
      list: async () => { calls.push("list"); throw new Error("unexpected list") },
      run: async () => { calls.push("run"); throw new Error("unexpected run") },
      verify: async () => { calls.push("verify"); throw new Error("unexpected verify") },
    }
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", adapter, { caddyUser: "root" })
    expect(result).toMatchObject({ success: true, data: { root: "/home/ada/projects/site/dist", entries: 0, skipped: "caddy-root" } })
    expect(calls).toEqual([])
    expect(f.calls).toHaveLength(0)
    expect(f.nodes.get("/home/ada/projects/site/dist")!.acl.has("user:caddy")).toBe(false)
  })

  test("root Caddy identity still rejects roots outside the authorized owner scope", async () => {
    const f = fixture()
    const result = await projectStaticAclRepair("ada", "/home/ada/projects-other/site", f.adapter, { caddyUser: "root" })
    expect(result.success).toBe(false)
    expect(f.calls).toHaveLength(0)
  })

  test("unsupported non-root Caddy identities fail before path access or ACL commands", async () => {
    const calls: string[] = []
    const adapter: ProjectStaticAclRepairAdapter = {
      open: async () => { calls.push("open"); throw new Error("unexpected open") },
      mountId: async () => { calls.push("mountId"); throw new Error("unexpected mountId") },
      list: async () => { calls.push("list"); throw new Error("unexpected list") },
      run: async () => { calls.push("run"); throw new Error("unexpected run") },
      verify: async () => { calls.push("verify"); throw new Error("unexpected verify") },
    }
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", adapter, { caddyUser: "www-data" })
    expect(result).toMatchObject({ success: false, errorMessage: "unsupported Caddy identity for ACL repair: www-data; supported non-root identity is caddy" })
    expect(calls).toEqual([])
  })

  test("root Caddy identity rejects a NUL-containing root without inspecting paths", async () => {
    const calls: string[] = []
    const adapter: ProjectStaticAclRepairAdapter = {
      open: async () => { calls.push("open"); throw new Error("unexpected open") },
      mountId: async () => { calls.push("mountId"); throw new Error("unexpected mountId") },
      list: async () => { calls.push("list"); throw new Error("unexpected list") },
      run: async () => { calls.push("run"); throw new Error("unexpected run") },
      verify: async () => { calls.push("verify"); throw new Error("unexpected verify") },
    }
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site\0suffix", adapter, { caddyUser: "root" })
    expect(result.success).toBe(false)
    expect(calls).toEqual([])
  })

  test("rejects escaping paths and mismatched owners without running commands", async () => {
    const f = fixture()
    for (const root of ["/home/ada/projects", "/home/adam/projects/site", "/home/ada/projects/../other", "/home/ada/wiki2", "/tmp/ada/projects/site", "/home/ada/projects/site/", "/home/ada/projects/site\0suffix"]) {
      expect((await projectStaticAclRepair("ada", root, f.adapter)).success).toBe(false)
    }
    expect((await projectStaticAclRepair("../ada", "/home/ada/wiki", f.adapter)).success).toBe(false)
    expect(f.calls).toHaveLength(0)
  })

  test("rejects symbolic link ancestors and roots before ACL changes", async () => {
    const f = fixture()
    f.nodes.get("/home/ada/projects")!.kind = "symlink"
    expect((await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", f.adapter)).success).toBe(false)
    expect(f.calls).toHaveLength(0)
    expect(f.nodes.get("/home/ada/projects")!.kind).toBe("symlink")
  })

  test("rejects bind mounts at ancestors, the configured root, and nested entries even on the same device", async () => {
    const root = "/home/ada/projects/site/dist"
    for (const mounted of ["/home/ada", root, `${root}/nested`]) {
      const f = fixture()
      f.nodes.get(mounted)!.mountId = 2 // dev remains 1: a bind mount must still be rejected.
      const result = await projectStaticAclRepair("ada", root, f.adapter)
      expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("mount crossing") })
      expect(f.nodes.get(mounted)!.acl.has("user:caddy")).toBe(false)
      if (mounted !== `${root}/nested`) expect(f.calls).toHaveLength(0)
    }
  })

  test("rejects a mount introduced at the configured root after its descriptor was opened", async () => {
    const f = fixture()
    const root = "/home/ada/projects/site/dist"
    const original = f.adapter.open
    f.adapter.open = async (path, flags) => {
      const handle = await original(path, flags)
      if (path.endsWith("/dist") && f.nodes.get(root)!.ino < 10000) {
        // The descriptor pins the old inode; the served path is now a bind mount.
        f.nodes.set(root, { ...f.nodes.get(root)!, ino: 10000, mountId: 2 })
      }
      return handle
    }
    const result = await projectStaticAclRepair("ada", root, f.adapter)
    expect(result.success).toBe(false)
    expect(f.nodes.get(root)!.acl.has("user:caddy")).toBe(false)
  })

  test("repairs every real descendant, adds defaults, skips symlinks and retains existing effective ACL rights", async () => {
    const f = fixture()
    const root = "/home/ada/projects/site/dist"
    const node = f.nodes.get(root)!
    node.acl.set("user:someone", "rwx")
    node.acl.set("group:team", "rwx")
    node.acl.set("mask:", "r--")
    node.acl.set("default:user:", "rwx")
    node.acl.set("default:group:", "rwx")
    node.acl.set("default:other:", "---")
    node.acl.set("default:user:someone", "rwx")
    node.acl.set("default:mask:", "r--")
    const nested = f.nodes.get(`${root}/nested`)!
    nested.acl.set("default:user:", "rwx")
    nested.acl.set("default:group:", "rwx")
    nested.acl.set("default:other:", "---")
    nested.acl.set("default:user:someone", "rwx")
    nested.acl.set("default:mask:", "r--")
    const result = await projectStaticAclRepair("ada", root, f.adapter)
    expect(result).toMatchObject({ success: true, data: { root, entries: 3 } })
    expect(node.acl.get("user:caddy")).toBe("r-x")
    expect(node.acl.get("mask:")).toBe("r-x")
    expect(node.acl.get("user:someone")).toBe("r--")
    expect(node.acl.get("group:team")).toBe("r--")
    expect(node.acl.get("default:user:someone")).toBe("r--")
    expect(node.acl.get("default:mask:")).toBe("r-x")
    expect(nested.acl.get("default:user:caddy")).toBe("r-x")
    expect(nested.acl.get("default:user:someone")).toBe("r--")
    expect(nested.acl.get("default:mask:")).toBe("r-x")
    expect(f.nodes.get(`${root}/nested/page.html`)!.acl.get("user:caddy")).toBe("r--")
    expect(f.nodes.get(`${root}/link`)!.acl.has("user:caddy")).toBe(false)
    expect(f.nodes.get("/home/ada")!.acl.get("user:caddy")).toBe("--x")
    expect(f.calls.some(({ command, args }) => command === "setfacl" && args.at(-1)?.includes("/fd/"))).toBe(true)
  })

  test("grants and verifies X on executable files", async () => {
    const f = fixture()
    const script = f.nodes.get("/home/ada/projects/site/dist/nested/page.html")!
    script.mode = 0o755
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", f.adapter)
    expect(result.success).toBe(true)
    expect(script.acl.get("user:caddy")).toBe("r-x")
    expect(script.acl.get("user:caddy")).toContain("x")
  })

  test("accepts the wiki subtree but not a neighboring path", async () => {
    const f = fixture()
    f.nodes.set("/home/ada/wiki", { kind: "directory", mode: 0o755, ino: 1000, nlink: 1, mountId: 1, children: [], acl: new Map([["user:", "rwx"], ["group:", "r-x"], ["other:", "---"]]) })
    expect((await projectStaticAclRepair("ada", "/home/ada/wiki", f.adapter)).success).toBe(true)
    expect((await projectStaticAclRepair("ada", "/home/ada/wiki-backup", f.adapter)).success).toBe(false)
  })

  test("accepts authorized owners with uppercase letters and dots without relaxing path boundaries", async () => {
    const f = fixture()
    const owner = "Ada.Name"
    const root = `/home/${owner}/wiki`
    const parent = f.nodes.get("/home/ada")!
    f.nodes.set(`/home/${owner}`, { ...parent, ino: 1001, children: ["wiki"], acl: new Map(parent.acl) })
    f.nodes.set(root, { ...f.nodes.get("/home/ada/projects/site/dist")!, ino: 1002, children: [], acl: new Map(parent.acl) })
    expect((await projectStaticAclRepair(owner, root, f.adapter)).success).toBe(true)
    expect((await projectStaticAclRepair(owner, "/home/Ada.Name2/wiki", f.adapter)).success).toBe(false)
  })

  test("reports command and verification failures", async () => {
    const failing = fixture()
    failing.failWith("setfacl")
    expect(await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", failing.adapter)).toMatchObject({ success: false })
    const verification = fixture()
    verification.failVerification()
    expect(await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", verification.adapter)).toMatchObject({ success: false })
    const masked = fixture()
    const original = masked.adapter.run
    masked.adapter.run = async (command, args) => {
      const result = await original(command, args)
      if (command === "setfacl") masked.nodes.get("/home")!.acl.set("mask:", "---")
      return result
    }
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", masked.adapter)
    expect(result).toMatchObject({ success: false, errorMessage: "Partial ACL repair may have occurred: Caddy ACL is masked" })
  })

  test("reports possible partial repair when a later ACL operation fails", async () => {
    const f = fixture()
    const run = f.adapter.run
    let writes = 0
    f.adapter.run = async (command, args) => {
      if (command === "setfacl" && args.includes("--modify")) writes++
      if (command === "getfacl" && writes > 0) return { exitCode: 1, stdout: "", stderr: "denied" }
      return run(command, args)
    }
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", f.adapter)
    expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("Partial ACL repair may have occurred") })
  })

  test("does not write shared ancestors when Caddy already has traversal", async () => {
    const f = fixture()
    f.nodes.get("/")!.acl.set("other:", "r-x")
    f.nodes.get("/home")!.acl.set("other:", "r-x")
    expect((await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", f.adapter)).success).toBe(true)
    expect(f.nodes.get("/")!.acl.has("user:caddy")).toBe(false)
    expect(f.nodes.get("/home")!.acl.has("user:caddy")).toBe(false)
  })

  test("does not write ACLs again after a successful repair", async () => {
    const f = fixture()
    const root = "/home/ada/projects/site/dist"
    expect((await projectStaticAclRepair("ada", root, f.adapter)).success).toBe(true)
    const writes = f.calls.filter(({ command }) => command === "setfacl").length
    expect(writes).toBeGreaterThan(0)
    expect((await projectStaticAclRepair("ada", root, f.adapter)).success).toBe(true)
    expect(f.calls.filter(({ command }) => command === "setfacl")).toHaveLength(writes)
  })

  test("rejects a hardlinked file before changing its ACL", async () => {
    const f = fixture()
    const file = f.nodes.get("/home/ada/projects/site/dist/nested/page.html")!
    file.nlink = 2
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", f.adapter)
    expect(result).toMatchObject({ success: false, errorMessage: expect.stringContaining("hardlinked static entry") })
    expect(file.acl.has("user:caddy")).toBe(false)
  })

  test("rejects a served pathname replaced during permission verification", async () => {
    const f = fixture()
    const root = "/home/ada/projects/site/dist"
    const original = f.adapter.verify
    f.adapter.verify = async (fd, permission) => {
      await original(fd, permission)
      if (permission === "-r" && f.nodes.get(root)!.ino < 10000) {
        f.nodes.set(root, { ...f.nodes.get(root)!, ino: 10000 })
      }
    }
    expect(await projectStaticAclRepair("ada", root, f.adapter)).toMatchObject({ success: false, errorMessage: `Partial ACL repair may have occurred: static path changed: ${root}` })
  })

  test("does not grant a pinned file after it has been renamed out of the served tree", async () => {
    const f = fixture()
    const file = "/home/ada/projects/site/dist/nested/page.html"
    let fileFd: number | undefined
    const open = f.adapter.open
    f.adapter.open = async (path, flags) => {
      const handle = await open(path, flags)
      if (path.endsWith("/page.html") && fileFd === undefined) fileFd = handle.fd
      return handle
    }
    const original = f.adapter.run
    f.adapter.run = async (command, args) => {
      const result = await original(command, args)
      if (command === "getfacl" && fileFd !== undefined && args.at(-1)?.endsWith(`/fd/${fileFd}`) && f.nodes.get(file)!.ino < 10000) {
        // The pathname has changed between ACL read and the attempted mutation.
        f.nodes.set(file, { ...f.nodes.get(file)!, ino: 10000 })
      }
      return result
    }
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", f.adapter)
    expect(result).toMatchObject({ success: false, errorMessage: `Partial ACL repair may have occurred: static path changed: ${file}` })
    expect(f.nodes.get(file)!.acl.has("user:caddy")).toBe(false)
  })

  test("restores the pinned inode ACL when a rename occurs during setfacl", async () => {
    const f = fixture()
    const file = "/home/ada/projects/site/dist/nested/page.html"
    const originalNode = f.nodes.get(file)!
    const replacementAcl = new Map(originalNode.acl)
    let fileFd: number | undefined
    const open = f.adapter.open
    f.adapter.open = async (path, flags) => {
      const handle = await open(path, flags)
      if (path.endsWith("/page.html") && fileFd === undefined) fileFd = handle.fd
      return handle
    }
    const run = f.adapter.run
    f.adapter.run = async (command, args) => {
      const result = await run(command, args)
      if (command === "setfacl" && args.includes("--modify") && args.at(-1)?.endsWith(`/fd/${fileFd}`)) {
        f.nodes.set(file, { ...originalNode, ino: 10000, acl: replacementAcl })
      }
      return result
    }
    const result = await projectStaticAclRepair("ada", "/home/ada/projects/site/dist", f.adapter)
    expect(result).toMatchObject({ success: false, errorMessage: `Partial ACL repair may have occurred: static path changed: ${file}` })
    expect(originalNode.acl.has("user:caddy")).toBe(false)
    expect(f.nodes.get(file)!.acl.has("user:caddy")).toBe(false)
    expect(f.calls.some(({ command, args }) => command === "setfacl" && args.includes("--set"))).toBe(true)
  })
})
