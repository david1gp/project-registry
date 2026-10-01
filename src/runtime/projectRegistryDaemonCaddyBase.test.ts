import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createResult, createResultError } from "#result"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import type { CaddyConfig } from "../caddy/CaddyConfig.js"
import { caddyConfigHostnames } from "../caddy/caddyConfigHostnames.js"
import { localCertificatesProvisionerCreate } from "../local-certificates/localCertificatesProvisionerCreate.js"
import type { Project } from "../project/Project.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonOpen } from "./projectRegistryDaemonOpen.js"

test("preserved JSON environment is optional in root mode and rejects invalid paths", () => {
  const environment = { PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/opencode/repository" }
  const defaults = projectRegistryDaemonConfigFromEnv(environment)
  expect(defaults).toMatchObject({ success: true, data: { mode: "root" } })
  if (defaults.success) {
    expect(defaults.data.caddyBaseConfigPath).toBeUndefined()
    expect(defaults.data.localDomains).toBeUndefined()
  }
  for (const path of ["", "relative.json", "/bad\0path"]) {
    expect(
      projectRegistryDaemonConfigFromEnv({ ...environment, PROJECT_REGISTRY_CADDY_BASE_CONFIG_PATH: path }).success,
    ).toBe(false)
  }
  expect(
    projectRegistryDaemonConfigFromEnv({
      ...environment,
      PROJECT_REGISTRY_CADDY_BASE_CONFIG_PATH: "/preserved/caddy.json",
    }),
  ).toMatchObject({
    success: true,
    data: { caddyBaseConfigPath: "/preserved/caddy.json" },
  })
})

test("daemon preserves 78 baseline routes and TLS tags, certificates cover the merged host union, deletion needs no ownership history", async () => {
  const root = await mkdtemp("/tmp/opencode/registry-base-compose-")
  const hosts = Array.from({ length: 78 }, (_, index) => `baseline-${index}.dev`)
  const base = {
    apps: {
      tls: {
        automation: { policies: [] },
        certificates: {
          load_pem: [{ certificate: "opaque", key: "opaque", tags: ["other"] }],
          load_files: [{ certificate: "/existing/cert.pem", key: "/existing/key.pem", tags: ["cert0"] }],
        },
      },
      http: {
        servers: {
          srv0: {
            listen: [":443"],
            tls_connection_policies: [{ certificate_selection: { any_tag: ["cert0"] } }],
            routes: hosts.map((host) => ({
              match: [{ host: [host] }],
              terminal: true,
              handle: [
                { handler: "headers", response: { set: { "X-Preserved": [host] } } },
                { handler: "reverse_proxy", upstreams: [{ dial: "localhost:1234" }] },
              ],
            })),
          },
        },
      },
    },
  }
  const basePath = join(root, "base.json")
  const localDomains = {
    mkcertBinary: "/test/unused-mkcert",
    stateDirectory: join(root, "certificates"),
    hostsFilePath: join(root, "hosts"),
  }
  const readiness = async () => createResult({ ready: true, clean: true, revision: "one" })
  const unused = async () => createResultError("test", "not used")
  let projects: Project[] = [
    structuredClone(caddyConfigGenerateFixtures.proxy),
    {
      schemaVersion: 2,
      owner: "leo",
      name: "baseline-metadata",
      order: 0,
      labels: {},
      services: [
        {
          id: "imported",
          ownership: "external",
          units: [],
          caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: [hosts[0]!] },
        },
      ],
    },
  ]
  let revision = 1
  const repository: ProjectRepository = {
    read: async () => createResult({ revision: String(revision), projects }),
    get: unused,
    getUserDefaultDomain: unused,
    create: unused,
    edit: unused,
    delete: unused,
    transact: unused,
    migrate: unused,
    setUserDefaultDomain: unused,
    history: unused,
    ownerHistory: unused,
    readiness,
    recover: readiness,
  }
  const loaded: CaddyConfig[] = []
  const validated: CaddyConfig[] = []
  const seed = localCertificatesProvisionerCreate({
    binary: localDomains.mkcertBinary,
    stateDirectory: localDomains.stateDirectory,
    run: async (_binary, args) => {
      await writeFile(args[1]!, "certificate")
      await writeFile(args[3]!, "key")
      return { exitCode: 0, stderr: "" }
    },
  })
  try {
    await writeFile(basePath, JSON.stringify(base))
    await writeFile(localDomains.hostsFilePath, "127.0.0.1 localhost\n")
    const first = await seed.provision([...hosts, ...caddyConfigGenerateFixtures.proxy.caddy.domains])
    expect(first.success).toBe(true)
    if (!first.success) return
    const daemonR = await projectRegistryDaemonOpen({
      config: {
        repositoryPath: root,
        caddyBaseConfigPath: basePath,
        localDomains,
        initializeFromGeneratedConfig: true,
        serverIp: "127.0.0.1",
        cloudflareDns: { enabled: false },
      },
      requireRoot: false,
      repository,
      timer: { wait: async () => undefined, setInterval: () => 1, clearInterval: () => undefined },
      caddyProcessRunner: async (_binary, _args, body) => {
        validated.push(JSON.parse(body))
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      caddyFetch: async (_url, init) => {
        loaded.push(JSON.parse(init.body as string))
        return new Response("", { status: 200 })
      },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    try {
      expect((await daemonR.data.caddyApplication.startup()).success).toBe(true)
      expect(loaded).toHaveLength(1)
      expect(validated[0]).toEqual(loaded[0])
      expect(loaded[0]!.apps.http.servers.srv0.routes.slice(0, 78)).toEqual(base.apps.http.servers.srv0.routes)
      expect(caddyConfigHostnames(loaded[0]!)).toEqual([...hosts, "oc.example", "opencode.example"].sort())
      expect(loaded[0]!.apps.tls!.automation).toEqual(base.apps.tls.automation)
      expect(loaded[0]!.apps.tls!.certificates.load_pem).toEqual(base.apps.tls.certificates.load_pem)
      expect(loaded[0]!.apps.tls!.certificates.load_files).toEqual([
        ...base.apps.tls.certificates.load_files,
        { certificate: first.data.certificatePath, key: first.data.privateKeyPath, tags: ["cert0"] },
      ])
      expect((loaded[0]!.apps.http.servers.srv0 as unknown as Record<string, unknown>).tls_connection_policies).toEqual(
        base.apps.http.servers.srv0.tls_connection_policies,
      )
      expect(await readFile(localDomains.hostsFilePath, "utf8")).toContain("127.0.0.1 baseline-0.dev\n")
      await writeFile(basePath, "invalid changed baseline")
      projects = []
      revision++
      expect((await seed.provision(hosts)).success).toBe(true)
      expect((await daemonR.data.caddyApplication.projectChange()).success).toBe(true)
      expect(loaded[1]!.apps.http.servers.srv0.routes).toEqual(base.apps.http.servers.srv0.routes)
      expect(await readFile(localDomains.hostsFilePath, "utf8")).not.toContain("opencode.example")
      projects = [
        {
          ...structuredClone(caddyConfigGenerateFixtures.proxy),
          caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: [hosts[0]!] },
        },
      ]
      revision++
      expect((await daemonR.data.caddyApplication.projectChange()).success).toBe(false)
      expect(loaded).toHaveLength(2)
      expect(validated).toHaveLength(2)
    } finally {
      await daemonR.data.caddyApplication.stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("daemon rejects unreadable, malformed and non-object preserved JSON before opening a repository", async () => {
  const root = await mkdtemp("/tmp/opencode/registry-base-invalid-")
  try {
    const path = join(root, "base.json")
    for (const body of [undefined, "not JSON", "[]", "null"]) {
      if (body !== undefined) await writeFile(path, body)
      const result = await projectRegistryDaemonOpen({
        config: { repositoryPath: join(root, "not-a-repository"), caddyBaseConfigPath: path },
        requireRoot: false,
      })
      expect(result).toMatchObject({ success: false, op: "caddyConfigBaseRead" })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("base-only root mode does not enable mkcert or hosts and retains imported TLS unchanged", async () => {
  const root = await mkdtemp("/tmp/opencode/registry-base-optout-")
  const base = {
    apps: {
      tls: {
        certificates: { load_files: [{ certificate: "/preserved/cert", key: "/preserved/key", tags: ["original"] }] },
      },
      http: { servers: { srv0: { listen: [":443"], routes: [] } } },
    },
  }
  const loaded: unknown[] = []
  try {
    const path = join(root, "base.json")
    await writeFile(path, JSON.stringify(base))
    const configR = projectRegistryDaemonConfigFromEnv({
      PROJECT_REGISTRY_REPOSITORY_PATH: join(root, "repository"),
      PROJECT_REGISTRY_CADDY_BASE_CONFIG_PATH: path,
      PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED: "false",
      PROJECT_REGISTRY_LOCAL_MKCERT_BINARY: "/nonexistent/mkcert",
      PROJECT_REGISTRY_LOCAL_HOSTS_FILE: join(root, "hosts"),
      SERVER_IP: "127.0.0.1",
      PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED: "false",
    })
    expect(configR.success).toBe(true)
    if (!configR.success) return
    const daemonR = await projectRegistryDaemonOpen({
      config: configR.data,
      requireRoot: false,
      timer: { wait: async () => undefined, setInterval: () => 1, clearInterval: () => undefined },
      caddyProcessRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
      caddyFetch: async (_url, init) => {
        loaded.push(JSON.parse(init.body as string))
        return new Response("", { status: 200 })
      },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    try {
      expect((await daemonR.data.caddyApplication.startup()).success).toBe(true)
      expect(loaded).toEqual([base])
      expect(await Bun.file(join(root, "hosts")).exists()).toBe(false)
    } finally {
      await daemonR.data.caddyApplication.stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
