import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createResult, createResultError } from "#result"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import type { CaddyConfig } from "../caddy/CaddyConfig.js"
import { localCertificatesProvisionerCreate } from "../local-certificates/localCertificatesProvisionerCreate.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"
import { projectRegistryDaemonOpen } from "./projectRegistryDaemonOpen.js"

const environment = {
  PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/opencode/repository",
  PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED: "true",
  PROJECT_REGISTRY_LOCAL_MKCERT_BINARY: "/usr/bin/mkcert",
  PROJECT_REGISTRY_LOCAL_CERTIFICATES_STATE_DIRECTORY: "/home/david/.local/state/project-registry/certificates",
  PROJECT_REGISTRY_LOCAL_HOSTS_FILE: "/var/lib/project-registry-david/hosts",
}

test("local domain automation requires explicit opt-in and all three absolute paths", () => {
  expect(projectRegistryDaemonConfigFromEnv(environment)).toMatchObject({
    success: true,
    data: {
      localDomains: {
        mkcertBinary: environment.PROJECT_REGISTRY_LOCAL_MKCERT_BINARY,
        stateDirectory: environment.PROJECT_REGISTRY_LOCAL_CERTIFICATES_STATE_DIRECTORY,
        hostsFilePath: environment.PROJECT_REGISTRY_LOCAL_HOSTS_FILE,
      },
    },
  })
  for (const name of [
    "PROJECT_REGISTRY_LOCAL_MKCERT_BINARY",
    "PROJECT_REGISTRY_LOCAL_CERTIFICATES_STATE_DIRECTORY",
    "PROJECT_REGISTRY_LOCAL_HOSTS_FILE",
  ] as const) {
    expect(projectRegistryDaemonConfigFromEnv({ ...environment, [name]: undefined }).success).toBe(false)
    expect(projectRegistryDaemonConfigFromEnv({ ...environment, [name]: "relative/path" }).success).toBe(false)
  }
  expect(
    projectRegistryDaemonConfigFromEnv({ ...environment, PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED: "invalid" }).success,
  ).toBe(false)
})

test("root and user defaults and explicit opt-out perform no local automation", () => {
  for (const values of [
    { PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/opencode/repository" },
    {
      PROJECT_REGISTRY_REPOSITORY_PATH: "/tmp/opencode/repository",
      PROJECT_REGISTRY_MODE: "user",
      USER: "david",
      HOME: "/home/david",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
    { ...environment, PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED: "false" },
    { ...environment, PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED: undefined },
  ]) {
    const result = projectRegistryDaemonConfigFromEnv(values)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.localDomains).toBeUndefined()
  }
})

test("local hosts configuration rejects /etc targets and version-relative paths", () => {
  for (const hostsFilePath of ["/etc/hosts", "/etc/hosts-registry", "/var/lib/../hosts"]) {
    expect(
      projectRegistryDaemonConfigValidate({
        repositoryPath: "/tmp/opencode/repository",
        localDomains: { mkcertBinary: "/usr/bin/mkcert", stateDirectory: "/tmp/opencode/certificates", hostsFilePath },
      }).success,
    ).toBe(false)
  }
})

test("daemon open composes local reconcilers and always loads new startup TLS even with generated-config initialization enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-local-daemon-"))
  const localDomains = {
    mkcertBinary: "/test/mkcert-not-executed",
    stateDirectory: join(root, "certificates"),
    hostsFilePath: join(root, "hosts"),
  }
  const readiness = async () => createResult({ ready: true, clean: true, revision: "one" })
  const unsupported = async () => createResultError("test", "not used")
  const repository: ProjectRepository = {
    read: async () => createResult({ revision: "one", projects: [caddyConfigGenerateFixtures.proxy] }),
    get: unsupported,
    getUserDefaultDomain: unsupported,
    create: unsupported,
    edit: unsupported,
    delete: unsupported,
    transact: unsupported,
    migrate: unsupported,
    setUserDefaultDomain: unsupported,
    history: unsupported,
    ownerHistory: unsupported,
    readiness,
    recover: readiness,
  }
  try {
    await writeFile(localDomains.hostsFilePath, "127.0.0.1 localhost\n")
    // Seed versioned files through the authoritative module using a fake mkcert runner.
    // Daemon startup must reuse this manifest without executing a real binary.
    const certificatesR = await localCertificatesProvisionerCreate({
      binary: localDomains.mkcertBinary,
      stateDirectory: localDomains.stateDirectory,
      run: async (_binary, args) => {
        await writeFile(args[1]!, "certificate")
        await writeFile(args[3]!, "key")
        return { exitCode: 0, stderr: "" }
      },
    }).provision(caddyConfigGenerateFixtures.proxy.caddy.domains)
    expect(certificatesR.success).toBe(true)
    if (!certificatesR.success) return
    const loaded: CaddyConfig[] = []
    const daemonR = await projectRegistryDaemonOpen({
      config: {
        repositoryPath: root,
        localDomains,
        initializeFromGeneratedConfig: true,
        serverIp: "127.0.0.1",
        cloudflareDns: { enabled: false },
      },
      requireRoot: false,
      repository,
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
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.apps.tls?.certificates.load_files).toEqual([
        { certificate: certificatesR.data.certificatePath, key: certificatesR.data.privateKeyPath },
      ])
      expect(await readFile(localDomains.hostsFilePath, "utf8")).toContain("127.0.0.1 oc.example\n")
    } finally {
      await daemonR.data.caddyApplication.stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
