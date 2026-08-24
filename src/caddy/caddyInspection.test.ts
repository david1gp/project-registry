import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { Actor } from "../access/Actor.js"
import * as publicApi from "../index.js"
import type { Project } from "../project/Project.js"
import { projectKey } from "../project/projectKey.js"
import { projectNormalize } from "../project/projectNormalize.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import { caddyConfigInspectUseCase } from "./caddyConfigInspectUseCase.js"
import { caddyConfigSelect } from "./caddyConfigSelect.js"
import { caddyConfigSerialize } from "./caddyConfigSerialize.js"
import { projectDocsUrls } from "./projectDocsUrls.js"
import { projectDocsUrlsUseCase } from "./projectDocsUrlsUseCase.js"

function project(
  owner: string,
  name: string,
  port: number,
  domain: string,
  settings: { disabled?: boolean; docs?: boolean; caddy?: null } = {},
): Project {
  const result = projectNormalize({
    owner,
    name,
    caddy:
      settings.caddy === null
        ? null
        : {
            port,
            domains: [domain],
            docs: settings.docs ?? true,
            disabled: settings.disabled ?? false,
          },
  })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

const ownProject = project("alice", "own-project", 3000, "alice.example")
const adminProject = project("bob", "admin-project", 3001, "bob.example")
const superadminProject = project("root", "super-project", 3002, "root.example")
const unresolvedProject = project("orphan", "orphan-project", 3003, "orphan.example")
const disabledProject = project("alice", "disabled-project", 3004, "disabled.example", { disabled: true })
const catalogProject = project("alice", "catalog-project", 3005, "catalog.example", { caddy: null })
const noDocsProject = project("alice", "no-docs-project", 3006, "no-docs.example", { docs: false })
const allProjects = [
  unresolvedProject,
  superadminProject,
  disabledProject,
  noDocsProject,
  catalogProject,
  adminProject,
  ownProject,
]

function actor(role: Actor["role"], username = "alice"): Actor {
  return { subject: `${username}-subject`, username, role }
}

function visibleProjects(current: Actor): Project[] {
  if (current.role === "superadmin") return [...allProjects]
  if (current.role === "admin") return allProjects.filter((item) => item.owner === "alice" || item.owner === "bob")
  return allProjects.filter((item) => item.owner === current.username)
}

function access() {
  return async (current: Actor) => createResult(visibleProjects(current))
}

function inspection(current: Actor, extra: Record<string, unknown> = {}) {
  return caddyConfigInspectUseCase({ actor: current, projectList: access(), ...extra })
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe("visibility-scoped Caddy inspection", () => {
  test("scopes own, admin, and superadmin configs and counts", async () => {
    const own = await inspection(actor("own"))
    const admin = await inspection(actor("admin"))
    const superadmin = await inspection(actor("superadmin", "root"))

    expect(own).toMatchObject({ success: true, data: { projectCount: 2, routeCount: 2 } })
    expect(admin).toMatchObject({ success: true, data: { projectCount: 3, routeCount: 3 } })
    expect(superadmin).toMatchObject({ success: true, data: { projectCount: 5, routeCount: 5 } })
    if (!own.success || !admin.success || !superadmin.success) return

    expect(serialized(own.data)).not.toContain("bob.example")
    expect(serialized(own.data)).not.toContain("root.example")
    expect(serialized(admin.data)).not.toContain("root.example")
    expect(serialized(admin.data)).not.toContain("orphan.example")
    expect(serialized(superadmin.data)).toContain("root.example")
    expect(serialized(superadmin.data)).toContain("orphan.example")

    const ignoredSnapshot = await inspection(actor("own"), { visibleProjects: [superadminProject] })
    expect(ignoredSnapshot).toMatchObject({ success: true, data: { projectCount: 2, routeCount: 2 } })
    expect(serialized(ignoredSnapshot)).not.toContain("root.example")
  })

  test("keeps superadmin-owned and unresolved-owner routes out of admin inspection", async () => {
    const result = await inspection(actor("admin"), { selector: "root.example" })
    expect(result).toMatchObject({ success: false })
    if (result.success) return
    expect(result.errorMessage).not.toContain("root.example")
    expect(serialized(result)).not.toContain("root.example")

    const orphan = await inspection(actor("admin"), { selector: "orphan-project" })
    expect(orphan.success).toBe(false)
    expect(serialized(orphan)).not.toContain("orphan.example")

    const full = caddyConfigGenerate(allProjects)
    expect(full.success).toBe(true)
    if (!full.success) return
    const scoped = caddyConfigSelect(full.data, visibleProjects(actor("admin")), "bob.example")
    expect(scoped.success).toBe(true)
    expect(serialized(scoped)).not.toContain("root.example")
  })

  test("supports multi-domain summaries and old selector matching", () => {
    const multi = projectNormalize({
      owner: "alice",
      name: "multi-domain",
      caddy: { port: 3010, domains: ["multi.example", "alias.example"], docs: true },
    })
    expect(multi.success).toBe(true)
    if (!multi.success) return

    const inspectionResult = [multi.data, ownProject]
    const configResult = inspection(actor("own"), { projectList: async () => createResult(inspectionResult) })
    return configResult.then((result) => {
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.summary.find((item) => item.name === "multi-domain")?.domains).toEqual([
        "multi.example",
        "alias.example",
      ])

      const byName = caddyConfigSelect(result.data.config, inspectionResult, "multi-domain")
      const byPort = caddyConfigSelect(result.data.config, inspectionResult, "3010")
      const byDomain = caddyConfigSelect(result.data.config, inspectionResult, "ALIAS.EXAMPLE")
      expect(byName.success).toBe(true)
      expect(byPort.success).toBe(true)
      expect(byDomain.success).toBe(true)
      expect(serialized(caddyConfigSerialize(result.data.config))).not.toContain("root.example")
    })
  })

  test("requires an unambiguous visible project for legacy and canonical selectors", () => {
    const aliceShared = project("alice", "shared-name", 3011, "alice-shared.example")
    const bobShared = project("bob", "shared-name", 3012, "bob-shared.example")
    const numericName = project("alice", "3012", 3013, "numeric-name.example")
    const numericPort = project("bob", "numeric-port", 3012, "numeric-port.example")
    const projects = [aliceShared, bobShared, numericName, numericPort]
    const generated = caddyConfigGenerate(projects)
    expect(generated.success).toBe(true)
    if (!generated.success) return

    expect(caddyConfigSelect(generated.data, projects, "shared-name").success).toBe(false)
    expect(caddyConfigSelect(generated.data, projects, "3012").success).toBe(false)

    const canonical = caddyConfigSelect(generated.data, projects, projectKey(aliceShared))
    expect(canonical.success).toBe(true)
    const ownerQualified = caddyConfigSelect(generated.data, projects, "bob/shared-name")
    expect(ownerQualified.success).toBe(true)
    const uniquePort = caddyConfigSelect(generated.data, projects, "3013")
    expect(uniquePort.success).toBe(true)
  })

  test("does not treat an absent canonical selector as a legacy domain", () => {
    const canonicalDomain = projectKey({ owner: "missing", name: "project" })
    const projectWithCanonicalDomain = project("alice", "canonical-domain", 3014, canonicalDomain)
    const generated = caddyConfigGenerate([projectWithCanonicalDomain])
    expect(generated.success).toBe(true)
    if (!generated.success) return

    const result = caddyConfigSelect(generated.data, [projectWithCanonicalDomain], canonicalDomain)
    expect(result).toEqual({
      success: false,
      op: "caddyConfigSelect",
      code: "caddy.not-found",
      errorMessage: "no server block matching selector",
    })
  })

  test("excludes disabled and catalog projects but keeps active no-docs routes in summaries", async () => {
    const result = await inspection(actor("own"))
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.summary.map((item) => item.name)).toEqual(["own-project", "no-docs-project"])
    expect(result.data.config.apps.http.servers.srv0.routes).toHaveLength(2)

    const disabledDocs = projectDocsUrls(disabledProject, "guide.md")
    const catalogDocs = projectDocsUrls(catalogProject, "guide.md")
    const noDocs = projectDocsUrls(noDocsProject, "guide.md")
    expect(disabledDocs).toMatchObject({
      success: false,
      code: "projects.disabled",
      errorMessage: "documentation project is disabled",
      hint: "Run: project-registry project edit disabled-project --enabled --docs",
    })
    expect(catalogDocs).toMatchObject({
      success: false,
      code: "documentation.invalid-configuration",
      errorMessage: "documentation configuration is invalid",
    })
    expect(noDocs).toMatchObject({
      success: false,
      code: "documentation.disabled",
      errorMessage: "documentation is disabled",
      hint: "Run: project-registry project edit no-docs-project --docs",
    })
  })

  test("generates documentation URLs only for visible active docs projects", async () => {
    const multiDomainProject = {
      ...ownProject,
      caddy: { ...ownProject.caddy!, domains: ["alice.example", "alice-alt.example"] },
    }
    const multiDomain = projectDocsUrls(multiDomainProject, "guide/intro.md")
    expect(multiDomain).toEqual({
      success: true,
      data: {
        urls: ["https://alice.example/docs/guide/intro.md", "https://alice-alt.example/docs/guide/intro.md"],
      },
    })

    const visible = await projectDocsUrlsUseCase({
      actor: actor("own"),
      projectList: access(),
      projectName: "own-project",
      relativePath: "/docs/guide/intro.md",
    })
    expect(visible).toEqual({ success: true, data: { urls: ["https://alice.example/docs/guide/intro.md"] } })

    const hidden = await projectDocsUrlsUseCase({
      actor: actor("admin"),
      projectList: access(),
      projectName: "super-project",
      relativePath: "guide.md",
    })
    expect(hidden.success).toBe(false)
    expect(serialized(hidden)).not.toContain("root.example")

    const noDocs = await projectDocsUrlsUseCase({
      actor: actor("own"),
      projectList: access(),
      projectName: "no-docs-project",
      relativePath: "guide.md",
    })
    expect(noDocs.success).toBe(false)
    expect(noDocs).toMatchObject({
      code: "documentation.disabled",
      hint: "Run: project-registry project edit no-docs-project --docs",
    })
  })

  test("does not aggregate documentation URLs for ambiguous visible names", async () => {
    const alice = project("alice", "shared-docs", 3011, "alice-docs.example")
    const bob = project("bob", "shared-docs", 3012, "bob-docs.example")
    const projectList = async () => createResult([alice, bob])

    const ambiguous = await projectDocsUrlsUseCase({
      actor: actor("superadmin", "root"),
      projectList,
      projectName: "shared-docs",
      relativePath: "guide.md",
    })
    expect(ambiguous).toEqual({
      success: false,
      op: "projectDocsUrlsUseCase",
      code: "projects.not-found",
      errorMessage: "documentation project is unavailable",
    })
    expect(serialized(ambiguous)).not.toContain("alice-docs.example")
    expect(serialized(ambiguous)).not.toContain("bob-docs.example")

    const owner = await projectDocsUrlsUseCase({
      actor: actor("superadmin", "root"),
      projectList,
      owner: "bob",
      projectName: "shared-docs",
      relativePath: "guide.md",
    })
    expect(owner).toEqual({ success: true, data: { urls: ["https://bob-docs.example/docs/guide.md"] } })
  })

  test("fails closed for malformed input without serializing project data", async () => {
    const malformedSelector = await inspection(actor("own"), { selector: { value: "alice.example" } })
    expect(malformedSelector.success).toBe(false)
    expect(serialized(malformedSelector)).not.toContain("alice.example")

    const malformedDocs = projectDocsUrls(ownProject, "../alice.example")
    expect(malformedDocs.success).toBe(false)
    expect(serialized(malformedDocs)).not.toContain("alice.example")
  })

  test("distinguishes invalid documentation input, configuration, and URL generation", () => {
    expect(projectDocsUrls(ownProject, "guide.html")).toMatchObject({
      success: false,
      code: "documentation.invalid-path",
    })
    expect(projectDocsUrls(ownProject, "guide.md", { scheme: "ftp" })).toMatchObject({
      success: false,
      code: "documentation.invalid-options",
    })
    expect(projectDocsUrls({ ...ownProject, caddy: null }, "guide.md")).toMatchObject({
      success: false,
      code: "documentation.invalid-configuration",
    })
    expect(
      projectDocsUrls({ ...ownProject, caddy: { ...ownProject.caddy!, domains: ["invalid domain"] } }, "guide.md"),
    ).toMatchObject({
      success: false,
      code: "documentation.url-generation-failed",
    })
  })

  test("fails closed for malformed project-list getters and dependency results", async () => {
    const bypass = await caddyConfigInspectUseCase({
      actor: actor("own"),
      visibleProjects: allProjects,
    } as never)
    expect(bypass.success).toBe(false)

    const directGetter = Object.defineProperty({ actor: actor("own") }, "projectList", {
      get() {
        throw new Error("hidden direct accessor")
      },
    })
    const direct = await caddyConfigInspectUseCase(directGetter as never)
    expect(direct.success).toBe(false)
    expect(serialized(direct)).not.toContain("hidden direct accessor")

    const proxy = Object.defineProperty({}, "projectList", {
      get() {
        throw new Error("hidden proxy accessor")
      },
    })
    const proxyResult = await caddyConfigInspectUseCase({ actor: actor("own"), access: proxy } as never)
    expect(proxyResult.success).toBe(false)
    expect(serialized(proxyResult)).not.toContain("hidden proxy accessor")

    const malformedDependency = await caddyConfigInspectUseCase({
      actor: actor("own"),
      projectList: async () => ({ success: true, data: [null] }),
    } as never)
    expect(malformedDependency.success).toBe(false)
    expect(serialized(malformedDependency)).not.toContain("alice.example")
  })

  test("does not expose unrestricted inspection or documentation helpers", async () => {
    expect(publicApi).toHaveProperty("caddyConfigInspectUseCase")
    for (const name of [
      "caddyConfigInspect",
      "caddyConfigSelect",
      "caddyConfigSummary",
      "caddyVisibleProjects",
      "projectDocsUrls",
    ]) {
      expect(publicApi).not.toHaveProperty(name)
    }

    const packageJson = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      exports?: Record<string, unknown>
    }
    expect(packageJson.exports).not.toHaveProperty("./*.js")
    const packageExportText = JSON.stringify(packageJson.exports)
    for (const name of [
      "caddyConfigInspect",
      "caddyConfigSelect",
      "caddyConfigSummary",
      "caddyVisibleProjects",
      "projectDocsUrls",
    ]) {
      expect(packageExportText).not.toContain(name)
    }
  })
})
