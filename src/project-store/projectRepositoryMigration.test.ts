import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { gitStoreOpen, gitStoreRun, gitStoreWrite } from "#git-store"
import type { ProjectCaddy } from "../project/projectCaddySchema.js"
import { projectRepositoryLeoServiceGroupings } from "./projectRepositoryLeoServiceGroupings.js"
import { projectRepositoryOpen } from "./projectRepositoryOpen.js"

const directories: string[] = []

function temporaryRepository(): string {
  const directory = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "project-registry-migration-"))
  directories.push(directory)
  return directory
}

function caddy(port: number, domain: string): ProjectCaddy {
  return {
    port,
    domains: [domain],
    path: "",
    access: "external" as const,
    kind: "proxy" as const,
    docs: false,
    browse: false,
    headerUp: {},
    disabled: false,
    denyDotfiles: false,
    spa: false,
  }
}

function legacyProject(
  name: string,
  port: number,
  options: {
    description?: string
    github?: string
    labels?: Record<string, string>
    type?: "own" | "internal" | "customer"
    units?: string[]
  } = {},
) {
  return {
    schemaVersion: 1 as const,
    owner: "leo",
    name,
    type: options.type ?? ("customer" as const),
    order: Number.MAX_SAFE_INTEGER,
    description: options.description,
    github: options.github,
    services: options.units ?? [`${name}.service`],
    labels: options.labels ?? {},
    caddy: caddy(port, `${name}.example`),
  }
}

async function seed(projects: readonly unknown[]): Promise<string> {
  const directory = temporaryRepository()
  const gitR = await gitStoreOpen({ dir: directory })
  expect(gitR.success).toBe(true)
  if (!gitR.success) return directory
  for (const project of projects) {
    const value = project as { owner: string; name: string }
    const writeR = await gitStoreWrite(gitR.data, `projects/${value.owner}/${value.name}.json`, project, "fixture")
    expect(writeR.success).toBe(true)
  }
  return directory
}

async function gitHead(directory: string): Promise<string> {
  const gitR = await gitStoreOpen({ dir: directory })
  expect(gitR.success).toBe(true)
  if (!gitR.success) return ""
  const headR = await gitStoreRun(gitR.data, ["rev-parse", "HEAD"])
  expect(headR.success).toBe(true)
  return headR.success ? headR.data.trim() : ""
}

async function fileBytes(directory: string): Promise<Record<string, string>> {
  const paths = [
    "projects/leo/emailoutreach.json",
    "projects/leo/emailoutreach-prod.json",
    "projects/leo/allgroups-chat.json",
    "projects/leo/allgroups-chat-ui.json",
    "projects/leo/allgroups-chat-convex.json",
    "projects/leo/allgroups-chat-api.json",
    "projects/leo/allgroups-chat-dash.json",
    "projects/leo/sales.json",
    "projects/leo/sales-api.json",
    "projects/leo/sales-web-preview.json",
    "projects/leo/sales-web-prod.json",
    "projects/leo/billing.json",
    "projects/leo/billing-preview.json",
  ]
  const result: Record<string, string> = {}
  for (const path of paths) result[path] = await readFile(join(directory, path), "utf8").catch(() => "")
  return result
}

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe("projectRepository.migrate", () => {
  test("canonicalizes losslessly, applies explicit Leo grouping, and is idempotent", async () => {
    const groupings = projectRepositoryLeoServiceGroupings.filter(
      ({ source }) =>
        ![
          "coachingcompany-api",
          "crm-api-preview",
          "crm-convex-preview",
          "akademie-api",
          "akademie-dev-api",
          "akademie-prod",
        ].includes(source.name),
    )
    const salesProject = legacyProject("sales", 3020)
    salesProject.caddy = { ...salesProject.caddy, domains: ["sales.contentoren.de"], disabled: true }
    const salesApiProject = legacyProject("sales-api", 3021)
    const salesWebPreviewProject = legacyProject("sales-web-preview", 3022)
    const salesWebProdProject = legacyProject("sales-web-prod", 3023)
    salesWebProdProject.caddy = { ...salesWebProdProject.caddy, domains: ["sales.contentoren.de"] }
    const billingProject = legacyProject("billing", 3135, { type: "internal", labels: { section: "Interne" } })
    billingProject.caddy = {
      ...billingProject.caddy,
      path: "/home/leo/projects/billing",
      domains: ["billing.contentoren.de"],
      docs: true,
    }
    const billingPreviewProject = legacyProject("billing-preview", 3146, {
      type: "internal",
      labels: { section: "Interne" },
    })
    billingPreviewProject.caddy = {
      ...billingPreviewProject.caddy,
      path: "/home/leo/projects/billing",
      domains: ["preview.billing.contentoren.de"],
      docs: true,
    }
    const directory = await seed([
      legacyProject("emailoutreach", 3000, { labels: { parent: "yes" } }),
      legacyProject("emailoutreach-prod", 3001, {
        github: "https://github.com/leo/emailoutreach-prod",
        labels: { source: "prod" },
        units: ["emailoutreach-web.service", "emailoutreach-worker.service"],
      }),
      legacyProject("allgroups-chat", 3010),
      legacyProject("allgroups-chat-ui", 3011),
      legacyProject("allgroups-chat-convex", 3012),
      legacyProject("allgroups-chat-api", 3013),
      legacyProject("allgroups-chat-dash", 3014),
      salesProject,
      salesApiProject,
      salesWebPreviewProject,
      salesWebProdProject,
      billingProject,
      billingPreviewProject,
    ])
    const before = await fileBytes(directory)
    const beforeHead = await gitHead(directory)
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const dryRunR = await openR.data.migrate({
      actor: "migration-test",
      dryRun: true,
      groupings,
    })
    expect(dryRunR).toMatchObject({ success: true, data: { dryRun: true, changed: true, canonicalized: 13 } })
    expect(await fileBytes(directory)).toEqual(before)
    expect(await gitHead(directory)).toBe(beforeHead)

    const migrationR = await openR.data.migrate({
      actor: "migration-test",
      groupings,
    })
    expect(migrationR).toMatchObject({
      success: true,
      data: {
        changed: true,
        canonicalized: 13,
        removed: [
          { owner: "leo", name: "allgroups-chat-api" },
          { owner: "leo", name: "allgroups-chat-convex" },
          { owner: "leo", name: "allgroups-chat-dash" },
          { owner: "leo", name: "allgroups-chat-ui" },
          { owner: "leo", name: "billing-preview" },
          { owner: "leo", name: "emailoutreach-prod" },
          { owner: "leo", name: "sales-api" },
          { owner: "leo", name: "sales-web-preview" },
          { owner: "leo", name: "sales-web-prod" },
        ],
      },
    })
    if (!migrationR.success) return

    const email = JSON.parse(await readFile(join(directory, "projects/leo/emailoutreach.json"), "utf8")) as Record<
      string,
      unknown
    >
    expect(email).toMatchObject({
      schemaVersion: 2,
      labels: { parent: "yes", source: "prod" },
      github: "https://github.com/leo/emailoutreach-prod",
      services: [
        { id: "default", units: ["emailoutreach.service"] },
        {
          id: "emailoutreach-prod",
          units: ["emailoutreach-web.service", "emailoutreach-worker.service"],
          caddy: { port: 3001, domains: ["emailoutreach-prod.example"] },
        },
      ],
    })
    const chat = JSON.parse(await readFile(join(directory, "projects/leo/allgroups-chat.json"), "utf8")) as Record<
      string,
      unknown
    >
    expect((chat.services as Array<{ id: string }>).map((service) => service.id)).toEqual([
      "default",
      "allgroups-chat-api",
      "allgroups-chat-convex",
      "allgroups-chat-dash",
      "allgroups-chat-ui",
    ])
    const salesCanonical = JSON.parse(await readFile(join(directory, "projects/leo/sales.json"), "utf8")) as {
      schemaVersion: number
      services: Array<{ id: string; caddy: ProjectCaddy | null }>
    }
    expect(salesCanonical.schemaVersion).toBe(2)
    expect(salesCanonical.services.map((service) => service.id)).toEqual([
      "default",
      "sales-api",
      "sales-web-preview",
      "sales-web-prod",
    ])
    expect(salesCanonical.services[0]?.caddy).toMatchObject({ domains: ["sales.contentoren.de"], disabled: true })
    expect(salesCanonical.services[3]?.caddy).toMatchObject({ domains: ["sales.contentoren.de"], disabled: false })
    const billingCanonical = JSON.parse(await readFile(join(directory, "projects/leo/billing.json"), "utf8")) as {
      schemaVersion: number
      type: string
      labels: Record<string, string>
      services: Array<{ id: string; caddy: ProjectCaddy | null }>
    }
    expect(billingCanonical).toMatchObject({ schemaVersion: 2, type: "internal", labels: { section: "Interne" } })
    expect(billingCanonical.services.map((service) => service.id)).toEqual(["default", "billing-preview"])
    expect(billingCanonical.services[0]?.caddy).toMatchObject({
      port: 3135,
      domains: ["billing.contentoren.de"],
      path: "/home/leo/projects/billing",
      access: "external",
      kind: "proxy",
      docs: true,
      disabled: false,
    })
    expect(billingCanonical.services[1]?.caddy).toMatchObject({
      port: 3146,
      domains: ["preview.billing.contentoren.de"],
      path: "/home/leo/projects/billing",
      access: "external",
      kind: "proxy",
      docs: true,
      disabled: false,
    })
    expect(await fileBytes(directory)).toMatchObject({
      "projects/leo/emailoutreach-prod.json": "",
      "projects/leo/allgroups-chat-ui.json": "",
      "projects/leo/allgroups-chat-convex.json": "",
      "projects/leo/allgroups-chat-api.json": "",
      "projects/leo/allgroups-chat-dash.json": "",
      "projects/leo/sales-api.json": "",
      "projects/leo/sales-web-preview.json": "",
      "projects/leo/sales-web-prod.json": "",
      "projects/leo/billing-preview.json": "",
    })

    const repeatR = await openR.data.migrate({
      actor: "migration-test",
      groupings,
    })
    expect(repeatR).toMatchObject({ success: true, data: { changed: false, localCommit: { status: "unchanged" } } })
    if (repeatR.success) expect(repeatR.data.revision).toBe(migrationR.data.revision)
    expect(await gitHead(directory)).toBe(migrationR.data.revision)
  })

  test("groups compatible coachingcompany and CRM preview records without changing service config", async () => {
    const coachingCaddy = {
      ...caddy(3134, "coachingcompany.leonardomora.de"),
      path: "/home/leo/projects/coachingcompany",
      docs: true,
    }
    const coachingApiCaddy = {
      ...caddy(8789, "api.coachingcompany.leonardomora.de"),
      path: "/home/leo/projects/coachingcompany",
      docs: true,
    }
    const crmCaddy = {
      ...caddy(3048, "crm.contentoren.de"),
      path: "/home/leo/projects/crm",
      access: "internal" as const,
      kind: "static" as const,
      docs: true,
    }
    const crmApiPreviewCaddy = {
      ...caddy(3223, "api.preview.crm.contentoren.de"),
      path: "/home/leo/projects/crm",
      docs: true,
    }
    const crmConvexPreviewCaddy = {
      ...caddy(3222, "convex.preview.crm.contentoren.de"),
      path: "/home/leo/projects/crm",
      docs: true,
    }
    const directory = await seed([
      {
        schemaVersion: 2,
        owner: "leo",
        name: "coachingcompany",
        type: "customer",
        order: 29,
        services: [{ id: "default", units: ["coachingcompany"], caddy: coachingCaddy }],
        labels: { section: "Kunden" },
        github: "https://github.com/Contentoren/coachingcompany",
        previewUrl: "https://coachingcompany.leonardomora.de",
        previewPort: "3134",
        productionUrl: "https://coachingcompany.pages.dev/",
      },
      {
        schemaVersion: 2,
        owner: "leo",
        name: "coachingcompany-api",
        type: "customer",
        order: Number.MAX_SAFE_INTEGER,
        services: [{ id: "default", units: [], caddy: coachingApiCaddy }],
        labels: { section: "Kunden" },
      },
      {
        schemaVersion: 2,
        owner: "leo",
        name: "crm",
        type: "customer",
        order: Number.MAX_SAFE_INTEGER,
        services: [{ id: "default", units: [], caddy: crmCaddy }],
        labels: {
          section: "Kunden",
          "link.assets-service":
            "https://assets-service.contentoren.de/projects/f79d82cd-7df2-4016-9a9f-caf589722c79/contributor",
        },
      },
      {
        schemaVersion: 2,
        owner: "leo",
        name: "crm-api-preview",
        type: "customer",
        order: Number.MAX_SAFE_INTEGER,
        services: [{ id: "default", units: [], caddy: crmApiPreviewCaddy }],
        labels: { section: "Kunden" },
      },
      {
        schemaVersion: 2,
        owner: "leo",
        name: "crm-convex-preview",
        type: "customer",
        order: Number.MAX_SAFE_INTEGER,
        services: [{ id: "default", units: [], caddy: crmConvexPreviewCaddy }],
        labels: { section: "Kunden" },
      },
    ])
    const groupings = projectRepositoryLeoServiceGroupings.filter(({ source }) =>
      ["coachingcompany-api", "crm-api-preview", "crm-convex-preview"].includes(source.name),
    )
    expect(groupings).toEqual([
      {
        source: { owner: "leo", name: "coachingcompany-api" },
        parent: { owner: "leo", name: "coachingcompany" },
        serviceId: "coachingcompany-api",
      },
      {
        source: { owner: "leo", name: "crm-api-preview" },
        parent: { owner: "leo", name: "crm" },
        serviceId: "crm-api-preview",
      },
      {
        source: { owner: "leo", name: "crm-convex-preview" },
        parent: { owner: "leo", name: "crm" },
        serviceId: "crm-convex-preview",
      },
    ])
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const migrationR = await openR.data.migrate({ actor: "migration-test", groupings })
    expect(migrationR).toMatchObject({
      success: true,
      data: {
        canonicalized: 0,
        removed: [
          { owner: "leo", name: "coachingcompany-api" },
          { owner: "leo", name: "crm-api-preview" },
          { owner: "leo", name: "crm-convex-preview" },
        ],
      },
    })

    const coaching = JSON.parse(await readFile(join(directory, "projects/leo/coachingcompany.json"), "utf8")) as {
      type: string
      github: string
      previewUrl: string
      previewPort: string
      productionUrl: string
      services: Array<{ id: string; units: string[]; caddy: ProjectCaddy; ownership?: string }>
    }
    expect(coaching).toMatchObject({
      type: "customer",
      github: "https://github.com/Contentoren/coachingcompany",
      previewUrl: "https://coachingcompany.leonardomora.de",
      previewPort: "3134",
      productionUrl: "https://coachingcompany.pages.dev/",
    })
    expect(coaching.services).toEqual([
      { id: "default", units: ["coachingcompany"], caddy: coachingCaddy, ownership: "registry" },
      { id: "coachingcompany-api", units: [], caddy: coachingApiCaddy, ownership: "registry" },
    ])

    const crm = JSON.parse(await readFile(join(directory, "projects/leo/crm.json"), "utf8")) as {
      type: string
      labels: Record<string, string>
      services: Array<{ id: string; units: string[]; caddy: ProjectCaddy; ownership?: string }>
    }
    expect(crm.type).toBe("customer")
    expect(crm.labels).toEqual({
      section: "Kunden",
      "link.assets-service":
        "https://assets-service.contentoren.de/projects/f79d82cd-7df2-4016-9a9f-caf589722c79/contributor",
    })
    expect(crm.services).toEqual([
      { id: "default", units: [], caddy: crmCaddy, ownership: "registry" },
      { id: "crm-api-preview", units: [], caddy: crmApiPreviewCaddy, ownership: "registry" },
      { id: "crm-convex-preview", units: [], caddy: crmConvexPreviewCaddy, ownership: "registry" },
    ])
    expect(await readFile(join(directory, "projects/leo/coachingcompany-api.json"), "utf8").catch(() => "")).toBe("")
    expect(await readFile(join(directory, "projects/leo/crm-api-preview.json"), "utf8").catch(() => "")).toBe("")
    expect(await readFile(join(directory, "projects/leo/crm-convex-preview.json"), "utf8").catch(() => "")).toBe("")
  })

  test("groups Akademie API records under the own project with explicit service IDs", async () => {
    const akademieCaddy = {
      ...caddy(3120, "preview.akademie.contentoren.de"),
      path: "/home/leo/projects/akademie",
    }
    const akademieApiCaddy = {
      ...caddy(8311, "api.akademie.contentoren.de"),
      path: "/home/leo/projects/akademie",
    }
    const akademieDevApiCaddy = {
      ...caddy(8309, "api.preview.akademie.contentoren.de"),
      path: "/home/leo/projects/akademie",
    }
    const akademieProdCaddy = {
      ...caddy(3122, "akademie.contentoren.de"),
      path: "/home/leo/projects/akademie",
    }
    const directory = await seed([
      {
        schemaVersion: 2,
        owner: "leo",
        name: "akademie",
        type: "customer",
        order: 5,
        services: [{ id: "default", units: ["akademie"], caddy: akademieCaddy }],
        labels: {
          section: "Eigene",
          "link.assets-service":
            "https://assets-service.contentoren.de/projects/5b9a584c-492d-4ade-8e70-773dab2dec89/contributor",
        },
        github: "https://github.com/Contentoren/akademie",
        previewUrl: "https://preview.akademie.contentoren.de",
        previewPort: "3120",
      },
      {
        schemaVersion: 2,
        owner: "leo",
        name: "akademie-api",
        type: "own",
        services: [{ id: "default", units: [], caddy: akademieApiCaddy, ownership: "external" }],
        labels: { section: "Eigene" },
      },
      {
        schemaVersion: 2,
        owner: "leo",
        name: "akademie-dev-api",
        type: "own",
        services: [{ id: "default", units: [], caddy: akademieDevApiCaddy }],
        labels: { section: "Eigene" },
      },
      {
        schemaVersion: 2,
        owner: "leo",
        name: "akademie-prod",
        type: "own",
        services: [{ id: "default", units: [], caddy: akademieProdCaddy }],
        labels: { section: "Eigene" },
      },
    ])
    const groupings = projectRepositoryLeoServiceGroupings.filter(({ parent }) => parent.name === "akademie")
    expect(groupings).toEqual([
      {
        source: { owner: "leo", name: "akademie-api" },
        parent: { owner: "leo", name: "akademie" },
        serviceId: "akademie-api",
      },
      {
        source: { owner: "leo", name: "akademie-dev-api" },
        parent: { owner: "leo", name: "akademie" },
        serviceId: "akademie-dev-api",
      },
      {
        source: { owner: "leo", name: "akademie-prod" },
        parent: { owner: "leo", name: "akademie" },
        serviceId: "akademie-prod",
      },
    ])
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const migrationR = await openR.data.migrate({ actor: "migration-test", groupings })
    expect(migrationR).toMatchObject({
      success: true,
      data: {
        canonicalized: 0,
        removed: [
          { owner: "leo", name: "akademie-api" },
          { owner: "leo", name: "akademie-dev-api" },
          { owner: "leo", name: "akademie-prod" },
        ],
      },
    })
    if (!migrationR.success) return

    const akademie = JSON.parse(await readFile(join(directory, "projects/leo/akademie.json"), "utf8")) as {
      type: string
      labels: Record<string, string>
      services: Array<{
        id: string
        units: string[]
        caddy: ProjectCaddy
        ownership?: string
      }>
    }
    expect(akademie).toMatchObject({
      type: "own",
      labels: {
        section: "Eigene",
        "link.assets-service":
          "https://assets-service.contentoren.de/projects/5b9a584c-492d-4ade-8e70-773dab2dec89/contributor",
      },
    })
    expect(akademie.services.map((service) => service.id)).toEqual([
      "default",
      "akademie-api",
      "akademie-dev-api",
      "akademie-prod",
    ])
    expect(akademie.services).toEqual([
      { id: "default", units: ["akademie"], caddy: akademieCaddy, ownership: "registry" },
      { id: "akademie-api", units: [], caddy: akademieApiCaddy, ownership: "external" },
      { id: "akademie-dev-api", units: [], caddy: akademieDevApiCaddy, ownership: "registry" },
      { id: "akademie-prod", units: [], caddy: akademieProdCaddy, ownership: "registry" },
    ])
    for (const name of ["akademie-api", "akademie-dev-api", "akademie-prod"]) {
      expect(await readFile(join(directory, `projects/leo/${name}.json`), "utf8").catch(() => "")).toBe("")
    }
  })

  test("rejects grouped service conflicts without writing or removing records", async () => {
    const parent = {
      schemaVersion: 2 as const,
      owner: "leo",
      name: "parent",
      type: "customer" as const,
      order: Number.MAX_SAFE_INTEGER,
      services: [{ id: "api", units: ["parent.service"], caddy: caddy(3100, "parent.example") }],
      labels: {},
    }
    const directory = await seed([parent, legacyProject("source", 3101)])
    const before = await fileBytes(directory)
    const beforeHead = await gitHead(directory)
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const migrationR = await openR.data.migrate({
      actor: "migration-test",
      groupings: [
        { source: { owner: "leo", name: "source" }, parent: { owner: "leo", name: "parent" }, serviceId: "api" },
      ],
    })
    expect(migrationR.success).toBe(false)
    if (!migrationR.success) expect(migrationR.errorMessage).toContain("service ID api already exists")
    expect(await fileBytes(directory)).toEqual(before)
    expect(await gitHead(directory)).toBe(beforeHead)
  })

  test("rejects invalid generated Caddy configuration before replacing legacy files", async () => {
    const project = legacyProject("invalid-static", 3200)
    project.caddy = { ...project.caddy, kind: "static" }
    const directory = await seed([project])
    const path = join(directory, "projects/leo/invalid-static.json")
    const before = await readFile(path, "utf8")
    const beforeHead = await gitHead(directory)
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const migrationR = await openR.data.migrate({ actor: "migration-test" })
    expect(migrationR.success).toBe(false)
    if (!migrationR.success) expect(migrationR.errorMessage).toContain("generated Caddy configuration is invalid")
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await gitHead(directory)).toBe(beforeHead)
  })
})
