import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createResult } from "#result"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import type { CaddyConfig } from "../caddy/CaddyConfig.js"
import { caddyApplicationCreate } from "../caddy/caddyApplicationCreate.js"
import { localCertificatesProvisionerCreate } from "../local-certificates/localCertificatesProvisionerCreate.js"
import type { Project } from "../project/Project.js"
import { localDomainsCaddyConfigReconcileCreate } from "./localDomainsCaddyConfigReconcileCreate.js"

const baseline = "127.0.0.1 localhost\n192.0.2.1 preserved.example\n"
const timer = { wait: async () => undefined, setInterval: () => 1, clearInterval: () => undefined }

async function harnessCreate() {
  const root = await mkdtemp(join(tmpdir(), "registry-local-wiring-"))
  const options = {
    mkcertBinary: "/test/mkcert",
    stateDirectory: join(root, "certificates"),
    hostsFilePath: join(root, "hosts"),
  }
  await writeFile(options.hostsFilePath, baseline)
  const issued: string[][] = []
  let fail = false
  const provisioner = localCertificatesProvisionerCreate({
    stateDirectory: options.stateDirectory,
    binary: options.mkcertBinary,
    run: async (binary, args) => {
      expect(binary).toBe("/test/mkcert")
      expect(args).not.toContain("-install")
      issued.push(args.slice(4))
      if (fail) return { exitCode: 1, stderr: "injected issuance failure" }
      await writeFile(args[1]!, "certificate")
      await writeFile(args[3]!, "key")
      return { exitCode: 0, stderr: "" }
    },
  })
  let revision = 0
  let projects: Project[] = [structuredClone(caddyConfigGenerateFixtures.proxy)]
  const loaded: CaddyConfig[] = []
  const validated: CaddyConfig[] = []
  const applicationR = caddyApplicationCreate({
    repository: { read: async () => createResult({ revision: String(revision), projects }) },
    configReconcile: localDomainsCaddyConfigReconcileCreate(options, provisioner),
    processRunner: async (_command: string, _args: readonly string[], input: string) => {
      validated.push(JSON.parse(input) as CaddyConfig)
      return createResult({ exitCode: 0, stdout: "", stderr: "" })
    },
    fetch: async (_url: string | URL | Request, init: RequestInit) => {
      loaded.push(JSON.parse(init.body as string) as CaddyConfig)
      return new Response("", { status: 200 })
    },
    timer,
    maxRetries: 0,
  })
  if (!applicationR.success) throw new Error(applicationR.errorMessage)
  return {
    application: applicationR.data,
    options,
    issued,
    loaded,
    validated,
    projectsSet: (next: Project[]) => {
      projects = next
      revision += 1
    },
    issuanceFail: () => {
      fail = true
    },
    cleanup: async () => {
      await applicationR.data.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function projectWithDomains(domains: string[]): Project {
  return {
    ...structuredClone(caddyConfigGenerateFixtures.proxy),
    caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains },
  }
}

test("startup, add, edit and last-domain removal reconcile hosts and versioned TLS at the shared load boundary", async () => {
  const h = await harnessCreate()
  try {
    expect((await h.application.startup()).success).toBe(true)
    expect(h.issued).toEqual([["oc.example", "opencode.example"]])
    const firstPair = h.loaded[0]?.apps.tls?.certificates.load_files[0]
    expect(firstPair?.certificate).toContain("/generation-")
    expect(h.validated[0]?.apps.tls).toEqual(h.loaded[0]?.apps.tls)
    expect((await readFile(h.options.hostsFilePath, "utf8")).startsWith(baseline)).toBe(true)

    expect((await h.application.projectChange()).success).toBe(true)
    expect(h.issued).toHaveLength(1)
    expect(h.loaded).toHaveLength(1)

    h.projectsSet([projectWithDomains(["opencode.example", "oc.example", "added.example"])])
    expect((await h.application.projectChange()).success).toBe(true)
    expect(h.issued[1]).toEqual(["added.example", "oc.example", "opencode.example"])
    expect(h.loaded[1]?.apps.tls?.certificates.load_files[0]).not.toEqual(firstPair)

    h.projectsSet([projectWithDomains(["renamed.example"])])
    expect((await h.application.projectChange()).success).toBe(true)
    const hostsAfterEdit = await readFile(h.options.hostsFilePath, "utf8")
    expect(hostsAfterEdit).toContain("127.0.0.1 renamed.example\n")
    expect(hostsAfterEdit).not.toContain("added.example")
    expect(await readFile(firstPair!.certificate, "utf8")).toBe("certificate")

    h.projectsSet([])
    expect((await h.application.projectChange()).success).toBe(true)
    expect(h.issued).toHaveLength(3)
    expect(h.loaded[3]?.apps.tls).toBeUndefined()
    const hostsAfterDelete = await readFile(h.options.hostsFilePath, "utf8")
    expect(hostsAfterDelete.startsWith(baseline)).toBe(true)
    expect(hostsAfterDelete).not.toContain("renamed.example")
  } finally {
    await h.cleanup()
  }
})

test("failed issuance leaves hosts and previously loaded certificate paths unchanged and blocks validation/load", async () => {
  const h = await harnessCreate()
  try {
    expect((await h.application.startup()).success).toBe(true)
    const previousHosts = await readFile(h.options.hostsFilePath, "utf8")
    const previousManifest = await readFile(join(h.options.stateDirectory, "current.json"), "utf8")
    h.issuanceFail()
    h.projectsSet([projectWithDomains(["new.example"])])
    expect((await h.application.projectChange()).success).toBe(false)
    expect(h.loaded).toHaveLength(1)
    expect(h.validated).toHaveLength(1)
    expect(await readFile(h.options.hostsFilePath, "utf8")).toBe(previousHosts)
    expect(await readFile(join(h.options.stateDirectory, "current.json"), "utf8")).toBe(previousManifest)
    expect(h.application.status().pending).toBe(true)
  } finally {
    await h.cleanup()
  }
})

test("hosts publication failure blocks Caddy load even after certificates were successfully issued", async () => {
  const h = await harnessCreate()
  try {
    expect((await h.application.startup()).success).toBe(true)
    await writeFile(h.options.hostsFilePath, `${baseline}# BEGIN project-registry managed hosts\n`)
    h.projectsSet([projectWithDomains(["new.example"])])
    expect((await h.application.projectChange()).success).toBe(false)
    expect(h.issued).toHaveLength(2)
    expect(h.loaded).toHaveLength(1)
    expect(h.validated).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
})

test("only concrete active locally-owned entries are provisioned, excluding disabled, Pages, wildcard and IP hosts", async () => {
  const h = await harnessCreate()
  try {
    h.projectsSet([
      projectWithDomains(["Valid.Example.", "site.pages.dev", "*.wild.example", "127.0.0.1"]),
      structuredClone(caddyConfigGenerateFixtures.disabled),
      {
        schemaVersion: 2,
        owner: "leo",
        name: "external",
        order: 0,
        labels: {},
        services: [
          {
            id: "external",
            units: [],
            ownership: "external",
            caddy: { ...caddyConfigGenerateFixtures.proxy.caddy, domains: ["external.example"] },
          },
        ],
      },
    ])
    expect((await h.application.startup()).success).toBe(true)
    expect(h.issued).toEqual([["valid.example"]])
  } finally {
    await h.cleanup()
  }
})

test("without an opt-in reconciler ordinary Caddy application has no TLS file configuration", async () => {
  const loaded: CaddyConfig[] = []
  const applicationR = caddyApplicationCreate({
    repository: {
      read: async () => createResult({ revision: "root-default", projects: [caddyConfigGenerateFixtures.proxy] }),
    },
    processRunner: async () => createResult({ exitCode: 0, stdout: "", stderr: "" }),
    fetch: async (_url: string | URL | Request, init: RequestInit) => {
      loaded.push(JSON.parse(init.body as string))
      return new Response("", { status: 200 })
    },
    timer,
  })
  expect(applicationR.success).toBe(true)
  if (!applicationR.success) return
  try {
    expect((await applicationR.data.startup()).success).toBe(true)
    expect(loaded[0]?.apps.tls).toBeUndefined()
  } finally {
    await applicationR.data.stop()
  }
})
