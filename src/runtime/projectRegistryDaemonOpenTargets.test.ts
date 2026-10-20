import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createResult, createResultError } from "#result"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import { caddyConfigHostnames } from "../caddy/caddyConfigHostnames.js"
import type { CaddyConfig } from "../caddy/CaddyConfig.js"
import type { Project } from "../project/Project.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import { caddyInstanceTargetsResolve } from "../caddy/caddyInstanceTargetsResolve.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"
import { projectRegistryDaemonCaddyTargetCreate } from "./projectRegistryDaemonCaddyTargetCreate.js"
import { projectRegistryDaemonOpen } from "./projectRegistryDaemonOpen.js"

function dependencies(initial: Project[] = []) {
  let projects = initial
  let revision = 1
  const unused = async () => createResultError("test", "unused")
  const readiness = async () => createResult({ ready: true, clean: true, revision: String(revision) })
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
  const loaded: Array<{ url: string; config: CaddyConfig }> = []
  const validated: Array<{ binary: string; config: CaddyConfig }> = []
  return {
    loaded,
    validated,
    change(next: Project[]) {
      projects = next
      revision++
    },
    options: {
      repository,
      requireRoot: false,
      timer: { wait: async () => undefined, setInterval: () => 1, clearInterval: () => undefined },
      caddyProcessRunner: async (binary: string, _args: readonly string[], body: string) => {
        validated.push({ binary, config: JSON.parse(body) })
        return createResult({ exitCode: 0, stdout: "", stderr: "" })
      },
      caddyFetch: async (url: string, init: RequestInit) => {
        loaded.push({ url, config: JSON.parse(init.body as string) })
        return new Response("", { status: 200 })
      },
    },
  }
}

function project(visibility: "public" | "private"): Project {
  return {
    ...structuredClone(caddyConfigGenerateFixtures.proxy),
    name: visibility,
    caddy: {
      ...caddyConfigGenerateFixtures.proxy.caddy,
      domains: [`${visibility}.example`],
      networkVisibility: visibility,
    },
  }
}

test("daemon loads both admin URLs, preserves zero-route private baseline admin/TLS, and reconciles changes separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-targets-"))
  const privateBase = {
    admin: { listen: "127.0.0.1:2020" },
    apps: {
      tls: {
        automation: {
          policies: [
            {
              issuers: [
                {
                  module: "acme",
                  challenges: { dns: { provider: { name: "cloudflare", api_token: "{env.CLOUDFLARE_API_TOKEN}" } } },
                },
              ],
            },
          ],
        },
      },
      http: { servers: { srv0: { listen: ["100.122.200.114:443"], routes: [] } } },
    },
  }
  const privatePath = join(root, "private.json")
  const publicPath = join(root, "public.json")
  const publicBase = {
    admin: { listen: "127.0.0.1:2019" },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: ["203.0.113.10:443"],
            routes: [
              { match: [{ host: ["preserved.example"] }], handle: [{ handler: "static_response", body: "kept" }] },
            ],
          },
        },
      },
    },
  }
  try {
    await writeFile(privatePath, JSON.stringify(privateBase))
    await writeFile(publicPath, JSON.stringify(publicBase))
    for (const baseline of [undefined, publicPath]) {
      const harness = dependencies([project("public"), project("private")])
      const daemonR = await projectRegistryDaemonOpen({
        ...harness.options,
        config: {
          repositoryPath: root,
          caddyBinary: "/validation/plugin-superset-wrapper",
          initializeFromGeneratedConfig: true,
          cloudflareDns: { enabled: false },
          caddyInstances: {
            public: {
              adminUrl: "http://127.0.0.1:2019",
              httpsListeners: ["203.0.113.10:443"],
              ...(baseline === undefined ? {} : { baseConfigPath: baseline }),
            },
            private: {
              adminUrl: "http://127.0.0.1:2020",
              httpsListeners: ["100.122.200.114:443"],
              baseConfigPath: privatePath,
            },
          },
        },
      })
      expect(daemonR.success).toBe(true)
      if (!daemonR.success) return
      try {
        expect((await daemonR.data.caddyApplication.startup()).success).toBe(true)
        expect(harness.loaded.map((entry) => entry.url)).toEqual([
          "http://127.0.0.1:2019/load",
          "http://127.0.0.1:2020/load",
        ])
        const [publicLoad, privateLoad] = harness.loaded
        expect(caddyConfigHostnames(publicLoad!.config)).toEqual(
          baseline === undefined ? ["public.example"] : ["preserved.example", "public.example"],
        )
        expect(caddyConfigHostnames(privateLoad!.config)).toEqual(["private.example"])
        expect(privateLoad!.config).toMatchObject({ admin: privateBase.admin, apps: { tls: privateBase.apps.tls } })
        expect(publicLoad!.config.apps.http.servers.srv0.listen).toEqual(["203.0.113.10:443"])
        expect(privateLoad!.config.apps.http.servers.srv0.listen).toEqual(["100.122.200.114:443"])
        expect(harness.validated.map((entry) => entry.binary)).toEqual([
          "/validation/plugin-superset-wrapper",
          "/validation/plugin-superset-wrapper",
        ])
        harness.change([project("public")])
        expect((await daemonR.data.caddyApplication.projectChange()).success).toBe(true)
        expect(harness.loaded).toHaveLength(3)
        expect(harness.loaded[2]!.url).toBe("http://127.0.0.1:2020/load")
        expect(harness.loaded[2]!.config as unknown).toEqual(privateBase)
      } finally {
        await daemonR.data.caddyApplication.stop()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("daemon fails closed for private projects without a configured private target, including legacy mode", async () => {
  for (const caddyInstances of [undefined, { public: { httpsListeners: ["203.0.113.10:443"] } }]) {
    const harness = dependencies([project("private")])
    const daemonR = await projectRegistryDaemonOpen({
      ...harness.options,
      config: { repositoryPath: "/tmp/opencode/registry-targets", caddyInstances },
    })
    expect(daemonR.success).toBe(true)
    if (!daemonR.success) return
    try {
      const startupR = await daemonR.data.caddyApplication.startup()
      expect(startupR.success).toBe(false)
      if (!startupR.success) expect(startupR.errorMessage).toContain("private")
      expect(harness.loaded).toEqual([])
      expect(harness.validated).toEqual([])
    } finally {
      await daemonR.data.caddyApplication.stop()
    }
  }
})

test("daemon reads required private baseline before opening repository or loading either target", async () => {
  const harness = dependencies()
  expect(
    await projectRegistryDaemonOpen({
      ...harness.options,
      config: {
        repositoryPath: "/tmp/opencode/registry-targets",
        caddyInstances: {
          public: { httpsListeners: ["203.0.113.10:443"] },
          private: {
            adminUrl: "http://localhost:2020",
            httpsListeners: ["100.122.200.114:443"],
            baseConfigPath: "/tmp/opencode/missing-private-baseline.json",
          },
        },
      },
    }),
  ).toMatchObject({ success: false, op: "caddyConfigBaseRead" })
  expect(harness.loaded).toEqual([])
})

test("target construction inherits global OIDC and binary but uses each target's listeners and log root", async () => {
  const configR = projectRegistryDaemonConfigValidate({
    repositoryPath: "/tmp/registry-target-options",
    oidc: caddyConfigGenerateFixtures.oidcOptions,
    caddyBinary: "/validation/wrapper",
    caddyAccessLogRoot: "/var/log/registry-public",
  })
  expect(configR.success).toBe(true)
  if (!configR.success) return
  const publicTarget = caddyInstanceTargetsResolve(configR.data).public
  for (const target of [
    publicTarget,
    {
      adminUrl: "http://localhost:2020",
      httpsListeners: ["100.122.200.114:443"],
      accessLogRoot: "/var/log/registry-private",
    },
  ]) {
    const targetR = await projectRegistryDaemonCaddyTargetCreate(target, configR.data)
    expect(targetR).toMatchObject({
      success: true,
      data: {
        adminUrl: target.adminUrl,
        caddyBin: "/validation/wrapper",
        configOptions: {
          httpsListeners: target.httpsListeners,
          oidc: caddyConfigGenerateFixtures.oidcOptions,
          caddyAccessLogRoot: target.accessLogRoot,
        },
      },
    })
  }
})
