import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectRegistryDaemonCloudflareCredentialsCreate as exportedCredentialsCreate } from "../index.js"
import type { ProjectRegistryDaemonCloudflareCredentialsFilesystem } from "./ProjectRegistryDaemonCloudflareCredentialsFilesystem.js"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"
import { projectRegistryDaemonCloudflareCredentialsCreate } from "./projectRegistryDaemonCloudflareCredentialsCreate.js"
import { projectRegistryDaemonCloudflareCredentialsFilesystemDefault } from "./projectRegistryDaemonCloudflareCredentialsFilesystemDefault.js"

type Filesystem = {
  files: Map<string, string>
  paths: string[]
  lstat(path: string): Promise<ProjectRegistryDaemonFileStat | undefined>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<string>
}

function missingFileError(): Error & { code: string } {
  const error = new Error("missing file") as Error & { code: string }
  error.code = "ENOENT"
  return error
}

function filesystemCreate(): Filesystem {
  const value = {
    files: new Map<string, string>(),
    paths: [] as string[],
    async lstat(path: string): Promise<ProjectRegistryDaemonFileStat | undefined> {
      if (path.endsWith(".env")) {
        return value.files.has(path) ? { type: "file", mode: 0o600, uid: 0, gid: 0 } : undefined
      }
      return { type: "directory", mode: 0o700, uid: 0, gid: 0 }
    },
    async realpath(path: string): Promise<string> {
      return path
    },
    async readFile(path: string): Promise<string> {
      value.paths.push(path)
      const content = value.files.get(path)
      if (content === undefined) throw missingFileError()
      return content
    },
  }
  return value
}

describe("projectRegistryDaemonCloudflareCredentialsCreate", () => {
  test("resolves owner files, prefers CLOUDFLARE_API_TOKEN, and parses aliases without executing values", async () => {
    const filesystem = filesystemCreate()
    filesystem.files.set(
      "/srv/project-registry/cloudflare/leo.env",
      "export CF_API_TOKEN='alias-token'\r\nCLOUDFLARE_API_TOKEN=\"$(touch /tmp/project-registry-credential-test)\"\r\n",
    )
    filesystem.files.set("/srv/project-registry/cloudflare/david.env", "CF_API_TOKEN=david-token\n")
    const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
      directory: "/srv/project-registry/cloudflare",
      filesystem,
    })
    expect(credentialsR.success).toBe(true)
    if (!credentialsR.success) return

    await expect(credentialsR.data.tokenResolve("leo")).resolves.toMatchObject({
      success: true,
      data: "$(touch /tmp/project-registry-credential-test)",
    })
    await expect(credentialsR.data.tokenResolve("david")).resolves.toMatchObject({
      success: true,
      data: "david-token",
    })
    expect(filesystem.paths).toEqual([
      "/srv/project-registry/cloudflare/leo.env",
      "/srv/project-registry/cloudflare/david.env",
    ])
  })

  test("returns no credential for a missing owner file despite global tokens and rereads file changes", async () => {
    const filesystem = filesystemCreate()
    const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
      directory: "/etc/project-registry/cloudflare",
      filesystem,
    })
    expect(credentialsR.success).toBe(true)
    if (!credentialsR.success) return

    const preferred = process.env.CLOUDFLARE_API_TOKEN
    const alias = process.env.CF_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = "global-token"
    process.env.CF_API_TOKEN = "legacy-global-token"
    try {
      await expect(credentialsR.data.tokenResolve("fabian")).resolves.toMatchObject({ success: true, data: undefined })
    } finally {
      if (preferred === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = preferred
      if (alias === undefined) delete process.env.CF_API_TOKEN
      else process.env.CF_API_TOKEN = alias
    }
    filesystem.files.set("/etc/project-registry/cloudflare/fabian.env", "CLOUDFLARE_API_TOKEN=first-token\n")
    await expect(credentialsR.data.tokenResolve("fabian")).resolves.toMatchObject({
      success: true,
      data: "first-token",
    })
    filesystem.files.set("/etc/project-registry/cloudflare/fabian.env", "CF_API_TOKEN=changed-token\n")
    await expect(credentialsR.data.tokenResolve("fabian")).resolves.toMatchObject({
      success: true,
      data: "changed-token",
    })
  })

  test("does not read through a symlinked credentials directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "project-registry-cloudflare-read-directory-"))
    const target = join(parent, "target")
    const linkedDirectory = join(parent, "cloudflare-link")
    mkdirSync(target)
    writeFileSync(join(target, "leo.env"), "CLOUDFLARE_API_TOKEN=directory-target-token\n")
    symlinkSync(target, linkedDirectory)
    try {
      const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
        directory: linkedDirectory,
        filesystem: projectRegistryDaemonCloudflareCredentialsFilesystemDefault(),
      })
      expect(credentialsR.success).toBe(true)
      if (!credentialsR.success) return

      const tokenR = await credentialsR.data.tokenResolve("leo")
      expect(tokenR).toEqual({ success: true, data: undefined })
      expect(JSON.stringify(tokenR)).not.toContain("directory-target-token")
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test("does not read through a symlinked owner credential file", async () => {
    const parent = mkdtempSync(join(tmpdir(), "project-registry-cloudflare-read-owner-"))
    const directory = join(parent, "cloudflare")
    const target = join(parent, "owner-target.env")
    mkdirSync(directory)
    writeFileSync(target, "CLOUDFLARE_API_TOKEN=owner-target-token\n")
    symlinkSync(target, join(directory, "leo.env"))
    try {
      const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
        directory,
        filesystem: projectRegistryDaemonCloudflareCredentialsFilesystemDefault(),
      })
      expect(credentialsR.success).toBe(true)
      if (!credentialsR.success) return

      const tokenR = await credentialsR.data.tokenResolve("leo")
      expect(tokenR).toEqual({ success: true, data: undefined })
      expect(JSON.stringify(tokenR)).not.toContain("owner-target-token")
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test("rejects owner path traversal without reading outside the credentials directory", async () => {
    const filesystem = filesystemCreate()
    const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
      directory: "/etc/project-registry/cloudflare",
      filesystem,
    })
    expect(credentialsR.success).toBe(true)
    if (!credentialsR.success) return

    for (const owner of [".", "..", "../outside", "nested/owner", "nested\\owner", "owner\u0000suffix"]) {
      await expect(credentialsR.data.tokenResolve(owner)).resolves.toMatchObject({ success: true, data: undefined })
    }
    expect(filesystem.paths).toEqual([])
  })

  test("does not fall back to a global token and hides credential read failures", async () => {
    const filesystem = {
      async lstat(path: string): Promise<ProjectRegistryDaemonFileStat> {
        return path.endsWith(".env")
          ? { type: "file", mode: 0o600, uid: 0, gid: 0 }
          : { type: "directory", mode: 0o700, uid: 0, gid: 0 }
      },
      async realpath(path: string): Promise<string> {
        return path
      },
      async readFile(): Promise<string> {
        throw new Error("global-token should not be exposed")
      },
    }
    const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
      directory: "/etc/project-registry/cloudflare",
      filesystem,
    })
    expect(credentialsR.success).toBe(true)
    if (!credentialsR.success) return

    const tokenR = await credentialsR.data.tokenResolve("leo")
    expect(tokenR.success).toBe(false)
    if (tokenR.success) return
    expect(tokenR.errorMessage).toBe("Cloudflare credentials could not be read")
    expect(tokenR.errorMessage).not.toContain("global-token")
  })

  test("exports a writer that atomically updates private owner credentials and reloads the next token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "project-registry-cloudflare-"))
    try {
      const credentialsR = exportedCredentialsCreate({
        directory,
        filesystem: projectRegistryDaemonCloudflareCredentialsFilesystemDefault(),
      })
      expect(credentialsR.success).toBe(true)
      if (!credentialsR.success) return

      await expect(credentialsR.data.tokenSet("leo", "first-token")).resolves.toEqual({
        success: true,
        data: { updated: true },
      })
      expect(readFileSync(join(directory, "leo.env"), "utf8")).toBe("CLOUDFLARE_API_TOKEN=first-token\n")
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(join(directory, "leo.env")).mode & 0o777).toBe(0o600)
      await expect(credentialsR.data.tokenResolve("leo")).resolves.toMatchObject({
        success: true,
        data: "first-token",
      })

      await Promise.all([
        credentialsR.data.tokenSet("leo", "second-token"),
        credentialsR.data.tokenSet("leo", "third-token"),
      ])
      await expect(credentialsR.data.tokenResolve("leo")).resolves.toMatchObject({
        success: true,
        data: "third-token",
      })
      expect(readdirSync(directory)).toEqual(["leo.env"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("creates a new private credentials directory before writing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "project-registry-cloudflare-parent-"))
    const directory = join(parent, "cloudflare")
    try {
      const credentialsR = exportedCredentialsCreate({
        directory,
        filesystem: projectRegistryDaemonCloudflareCredentialsFilesystemDefault(),
      })
      expect(credentialsR.success).toBe(true)
      if (!credentialsR.success) return

      await expect(credentialsR.data.tokenSet("leo", "new-directory-token")).resolves.toMatchObject({
        success: true,
        data: { updated: true },
      })
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(join(directory, "leo.env")).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(directory, "leo.env"), "utf8")).toBe("CLOUDFLARE_API_TOKEN=new-directory-token\n")
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test("rejects symlinked and non-directory credentials paths before chmod or write", async () => {
    const parent = mkdtempSync(join(tmpdir(), "project-registry-cloudflare-unsafe-"))
    const target = join(parent, "target")
    const linkedDirectory = join(parent, "cloudflare-link")
    const filePath = join(parent, "cloudflare-file")
    mkdirSync(target)
    chmodSync(target, 0o755)
    symlinkSync(target, linkedDirectory)
    writeFileSync(filePath, "do-not-change\n")
    try {
      const linkedR = exportedCredentialsCreate({
        directory: linkedDirectory,
        filesystem: projectRegistryDaemonCloudflareCredentialsFilesystemDefault(),
      })
      expect(linkedR.success).toBe(true)
      if (!linkedR.success) return
      const linkedTokenR = await linkedR.data.tokenSet("leo", "symlink-token")
      expect(linkedTokenR).toMatchObject({
        success: false,
        errorMessage: "Cloudflare credentials could not be written",
      })
      expect(readdirSync(target)).toEqual([])
      expect(statSync(target).mode & 0o777).toBe(0o755)
      expect(JSON.stringify(linkedTokenR)).not.toContain("symlink-token")

      const fileR = exportedCredentialsCreate({
        directory: filePath,
        filesystem: projectRegistryDaemonCloudflareCredentialsFilesystemDefault(),
      })
      expect(fileR.success).toBe(true)
      if (!fileR.success) return
      await expect(fileR.data.tokenSet("leo", "file-token")).resolves.toMatchObject({
        success: false,
        errorMessage: "Cloudflare credentials could not be written",
      })
      expect(readFileSync(filePath, "utf8")).toBe("do-not-change\n")
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test("rejects empty, oversized, and env-injection tokens before filesystem writes", async () => {
    const filesystem = filesystemCreate()
    const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
      directory: "/etc/project-registry/cloudflare",
      filesystem,
    })
    expect(credentialsR.success).toBe(true)
    if (!credentialsR.success) return

    for (const token of [
      "",
      "token\nCLOUDFLARE_API_TOKEN=forged",
      "token\rforged",
      "token\u0000forged",
      "x".repeat(8_193),
    ]) {
      const tokenR = await credentialsR.data.tokenSet("leo", token)
      expect(tokenR).toMatchObject({ success: false, code: "request.invalid" })
    }
    expect(filesystem.paths).toEqual([])
  })

  test("hides filesystem write failures and never returns the credential", async () => {
    const secret = "secret-token-that-must-not-leak"
    const filesystem: ProjectRegistryDaemonCloudflareCredentialsFilesystem = {
      async lstat(path: string) {
        return path.endsWith(".env")
          ? { type: "file" as const, mode: 0o600, uid: 0, gid: 0 }
          : { type: "directory" as const, mode: 0o700, uid: 0, gid: 0 }
      },
      async realpath(path: string) {
        return path
      },
      async readFile() {
        throw new Error(secret)
      },
      async mkdir() {
        throw new Error(secret)
      },
      async chmod() {
        throw new Error(secret)
      },
      async writeFile() {
        throw new Error(secret)
      },
      async rename() {
        throw new Error(secret)
      },
      async unlink() {
        throw new Error(secret)
      },
    }
    const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
      directory: "/etc/project-registry/cloudflare",
      filesystem,
    })
    expect(credentialsR.success).toBe(true)
    if (!credentialsR.success) return

    const tokenR = await credentialsR.data.tokenSet("leo", secret)
    expect(tokenR).toMatchObject({ success: false, errorMessage: "Cloudflare credentials could not be written" })
    expect(JSON.stringify(tokenR)).not.toContain(secret)
  })
})
