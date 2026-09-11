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
  options: { description?: string; github?: string; labels?: Record<string, string>; units?: string[] } = {},
) {
  return {
    schemaVersion: 1 as const,
    owner: "leo",
    name,
    type: "customer" as const,
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
    "projects/leo/sales-web-prod.json",
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
      legacyProject("sales", 3020),
      legacyProject("sales-web-prod", 3021),
    ])
    const before = await fileBytes(directory)
    const beforeHead = await gitHead(directory)
    const openR = await projectRepositoryOpen({ dir: directory })
    expect(openR.success).toBe(true)
    if (!openR.success) return

    const dryRunR = await openR.data.migrate({
      actor: "migration-test",
      dryRun: true,
      groupings: projectRepositoryLeoServiceGroupings,
    })
    expect(dryRunR).toMatchObject({ success: true, data: { dryRun: true, changed: true, canonicalized: 9 } })
    expect(await fileBytes(directory)).toEqual(before)
    expect(await gitHead(directory)).toBe(beforeHead)

    const migrationR = await openR.data.migrate({
      actor: "migration-test",
      groupings: projectRepositoryLeoServiceGroupings,
    })
    expect(migrationR).toMatchObject({
      success: true,
      data: {
        changed: true,
        canonicalized: 9,
        removed: [
          { owner: "leo", name: "allgroups-chat-api" },
          { owner: "leo", name: "allgroups-chat-convex" },
          { owner: "leo", name: "allgroups-chat-dash" },
          { owner: "leo", name: "allgroups-chat-ui" },
          { owner: "leo", name: "emailoutreach-prod" },
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
    expect(JSON.parse(await readFile(join(directory, "projects/leo/sales.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      services: [{ id: "default" }],
    })
    expect(JSON.parse(await readFile(join(directory, "projects/leo/sales-web-prod.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      services: [{ id: "default" }],
    })
    expect(await fileBytes(directory)).toMatchObject({
      "projects/leo/emailoutreach-prod.json": "",
      "projects/leo/allgroups-chat-ui.json": "",
      "projects/leo/allgroups-chat-convex.json": "",
      "projects/leo/allgroups-chat-api.json": "",
      "projects/leo/allgroups-chat-dash.json": "",
    })

    const repeatR = await openR.data.migrate({
      actor: "migration-test",
      groupings: projectRepositoryLeoServiceGroupings,
    })
    expect(repeatR).toMatchObject({ success: true, data: { changed: false, localCommit: { status: "unchanged" } } })
    if (repeatR.success) expect(repeatR.data.revision).toBe(migrationR.data.revision)
    expect(await gitHead(directory)).toBe(migrationR.data.revision)
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
