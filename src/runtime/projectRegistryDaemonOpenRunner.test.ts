import { describe, expect, spyOn, test } from "bun:test"
import { createResult, createResultError } from "#result"
import type { CaddyProcessRunner } from "../caddy/CaddyProcessRunner.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"
import type { ProjectRegistryDaemonFilesystem } from "./ProjectRegistryDaemonFilesystem.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import { projectRegistryDaemonOpen } from "./projectRegistryDaemonOpen.js"

function repository(): ProjectRepository {
  const readiness = async () => createResult({ ready: true, clean: true, revision: "test" })
  const unused = async () => createResultError("test", "not implemented")
  return {
    read: async () => createResult({ revision: "test", projects: [] }),
    get: unused,
    getUserDefaultDomain: unused,
    create: unused,
    edit: unused,
    delete: unused,
    transact: unused,
    migrate: unused,
    setUserDefaultDomain: unused,
    history: async () => createResult([]),
    ownerHistory: async () => createResult([]),
    readiness,
    recover: readiness,
  }
}

function daemonDependencies() {
  const entries = new Map<string, ProjectRegistryDaemonFileStat>([
    ["/", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
    ["/run", { type: "directory", mode: 0o755, uid: 0, gid: 0 }],
  ])
  const filesystem: ProjectRegistryDaemonFilesystem = {
    lstat: async (path) => entries.get(path),
    realpath: async (path) => path,
    mkdir: async (path, mode) => {
      entries.set(path, { type: "directory", mode, uid: 0, gid: 0 })
    },
    readdir: async (path) =>
      [...entries.keys()]
        .filter((entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes("/"))
        .map((entry) => entry.slice(path.length + 1)),
    chmod: async () => undefined,
    chown: async () => undefined,
    unlink: async (path) => {
      entries.delete(path)
    },
  }
  const serverFactory: ProjectRegistryDaemonServerFactory = (options) => {
    if (options.unix !== undefined) entries.set(options.unix, { type: "socket", mode: 0o777, uid: 0, gid: 0 })
    return { stop: () => undefined }
  }
  return { filesystem, serverFactory }
}

const timer = {
  wait: async () => undefined,
  setInterval: () => undefined,
  clearInterval: () => undefined,
}

describe("projectRegistryDaemonOpen Caddy process runner composition", () => {
  test("uses the injected runner ahead of configured root identities", async () => {
    const { filesystem, serverFactory } = daemonDependencies()
    const calls: Array<{ command: string; args: readonly string[]; input: string }> = []
    const injectedRunner: CaddyProcessRunner = async (command, args, input) => {
      calls.push({ command, args, input })
      return createResult({ exitCode: 0, stdout: "", stderr: "" })
    }
    const daemonR = await projectRegistryDaemonOpen({
      config: {
        repositoryPath: "/tmp/project-registry-test",
        initializeFromGeneratedConfig: true,
        caddyBinary: "/usr/local/libexec/project-registry-caddy",
        caddyUser: "root",
        caddyGroup: "root",
      },
      repository: repository(),
      filesystem,
      serverFactory,
      timer,
      caddyProcessRunner: injectedRunner,
      posix: {
        isRoot: () => true,
        userResolve: async () => createResult({ username: "nobody", uid: 65534, gid: 65534 }),
      },
      requireRoot: false,
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return

    expect((await daemonR.data.start()).success).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      command: "/usr/local/libexec/project-registry-caddy",
      args: ["validate", "--config", "-", "--adapter", ""],
    })
    expect(calls[0]?.input).toContain('"apps"')
    await daemonR.data.shutdown()
  })

  test("executes the configured Caddy binary directly when identities are omitted", async () => {
    const { filesystem, serverFactory } = daemonDependencies()
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      stdout,
      stderr,
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>)
    try {
      const daemonR = await projectRegistryDaemonOpen({
        config: {
          repositoryPath: "/tmp/project-registry-test",
          initializeFromGeneratedConfig: true,
          caddyBinary: "/opt/caddy/bin/caddy",
        },
        repository: repository(),
        filesystem,
        serverFactory,
        timer,
        posix: {
          isRoot: () => true,
          userResolve: async () => createResult({ username: "nobody", uid: 65534, gid: 65534 }),
        },
        requireRoot: false,
      })
      expect(daemonR.success).toBe(true)
      if (!daemonR.success) return

      expect((await daemonR.data.start()).success).toBe(true)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn.mock.calls[0]?.[0]).toEqual(["/opt/caddy/bin/caddy", "validate", "--config", "-", "--adapter", ""])
      await daemonR.data.shutdown()
    } finally {
      spawn.mockRestore()
    }
  })
})
