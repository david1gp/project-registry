import { createResult } from "#result"
import type { DevProcessRunner } from "../../src/dev/DevProcessRunner.js"
import type { DevProjectFilesystem } from "../../src/dev/DevProjectFilesystem.js"
import type { ManagedServiceConfig } from "../../src/managed-service/ManagedServiceConfig.js"
import type { ManagedServiceFilesystem } from "../../src/managed-service/ManagedServiceFilesystem.js"
import type { Project } from "../../src/project/Project.js"

export const managedServiceConfigFixture: ManagedServiceConfig = {
  enabled: true,
  user: "projects",
  group: "projects",
  homeDirectory: "/home/projects",
  projectsRoot: "/projects",
  allowedUsers: ["leo", "david", "tim", "mit"],
  slice: "projects.slice",
  unitDirectory: "/etc/systemd/system",
  pathValue: "/usr/local/bin:/usr/bin:/bin",
  auditLogPath: "/var/lib/project-registry/managed-services-audit.jsonl",
}

export function managedServiceProjectFixture(
  owner: string,
  name: string,
  services: Array<{
    id: string
    port?: number
    service?: Record<string, unknown>
    ownership?: "registry" | "external"
  }>,
): Project {
  return {
    schemaVersion: 2,
    owner,
    name,
    order: 0,
    labels: {},
    services: services.map((service) => ({
      id: service.id,
      units: [],
      ownership: service.ownership ?? "registry",
      caddy:
        service.port === undefined ? null : { port: service.port, domains: [`${name}-${service.id}.example.test`] },
      ...(service.service === undefined ? {} : { service: service.service }),
    })),
  } as unknown as Project
}

export type RunnerCall = { command: string; args: readonly string[] }

export function managedServiceRunnerFake(
  calls: RunnerCall[],
  behavior: (call: RunnerCall) => { exitCode: number; stdout?: string; stderr?: string } = () => ({ exitCode: 0 }),
): DevProcessRunner {
  return async (command, args) => {
    const call = { command, args: [...args] }
    calls.push(call)
    const outcome = behavior(call)
    return createResult({ exitCode: outcome.exitCode, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" })
  }
}

export type ManagedServiceFilesystemFake = ManagedServiceFilesystem & {
  files: Map<string, string>
  writes: string[]
  removals: string[]
}

export function managedServiceFilesystemFake(initial: Record<string, string> = {}): ManagedServiceFilesystemFake {
  const files = new Map(Object.entries(initial))
  const fake: ManagedServiceFilesystemFake = {
    files,
    writes: [],
    removals: [],
    async list(directory) {
      return [...files.keys()]
        .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/"))
        .map((path) => path.slice(directory.length + 1))
    },
    async read(path) {
      return files.get(path)
    },
    async writeAtomic(path, content) {
      fake.writes.push(path)
      files.set(path, content)
    },
    async remove(path) {
      fake.removals.push(path)
      files.delete(path)
    },
    async append(path, content) {
      files.set(path, `${files.get(path) ?? ""}${content}`)
    },
  }
  return fake
}

/** Project tree: `/projects/<name>` directories with optional package.json bodies. */
export function managedServiceProjectFilesystemFake(
  projects: Record<string, { packageJson?: unknown; files?: string[]; symlinks?: Record<string, string> }>,
): DevProjectFilesystem {
  const directories = new Set(["/projects", ...Object.keys(projects).map((name) => `/projects/${name}`)])
  const files = new Map<string, string>()
  const symlinks = new Map<string, string>()
  for (const [name, project] of Object.entries(projects)) {
    if (project.packageJson !== undefined) {
      files.set(`/projects/${name}/package.json`, JSON.stringify(project.packageJson))
    }
    for (const file of project.files ?? []) files.set(`/projects/${name}/${file}`, "")
    for (const [link, target] of Object.entries(project.symlinks ?? {}))
      symlinks.set(`/projects/${name}/${link}`, target)
  }
  return {
    async readFile(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error("ENOENT")
      return content
    },
    async realpath(path) {
      const linked = symlinks.get(path)
      if (linked !== undefined) return linked
      if (directories.has(path) || files.has(path)) return path
      throw new Error("ENOENT")
    },
    async stat(path) {
      if (!directories.has(path) && !files.has(path)) throw new Error("ENOENT")
      return { isDirectory: () => directories.has(path) }
    },
  }
}
