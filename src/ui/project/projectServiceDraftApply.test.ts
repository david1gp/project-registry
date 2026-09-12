import { describe, expect, test } from "bun:test"
import * as v from "valibot"
import { projectServiceDraftApply } from "./projectServiceDraftApply.js"
import { projectServiceDraftFrom } from "./projectServiceDraftFrom.js"
import type { ProjectServicesService } from "./projectServicesSchema.js"
import { projectServicesSchema } from "./projectServicesSchema.js"

const caddy: NonNullable<ProjectServicesService["caddy"]> = {
  port: 3000,
  domains: ["app.example"],
  path: "/srv/app",
  access: "external",
  kind: "proxy",
  docs: true,
  browse: false,
  disabled: false,
  spa: false,
  denyDotfiles: false,
  headerUp: { Host: "localhost" },
}

const services: ProjectServicesService[] = [
  { id: "default", units: [], ownership: "registry", caddy: { ...caddy } },
  {
    id: "api",
    units: ["api.service"],
    ownership: "external",
    caddy: { ...caddy, port: 3001, domains: ["api.example"] },
  },
]

describe("projectServiceDraftApply", () => {
  test("edits one service while preserving sibling domains, ports, and Caddy settings", () => {
    const draft = {
      ...projectServiceDraftFrom(services[1], "api"),
      port: "3007",
      domains: "API2.example , api.example",
    }
    const result = projectServiceDraftApply(services, draft)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data[0]).toEqual(services[0]!)
    expect(result.data[1]?.caddy).toMatchObject({
      port: 3007,
      domains: ["api2.example", "api.example"],
      headerUp: { Host: "localhost" },
    })
    expect(result.data[1]?.ownership).toBe("external")
  })

  test("appends a new service when the drafted ID is unknown", () => {
    const draft = { ...projectServiceDraftFrom(undefined, "docs"), port: "3010", domains: "docs.example" }
    const result = projectServiceDraftApply(services, draft)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toHaveLength(3)
    expect(result.data[2]).toMatchObject({ id: "docs", units: [], caddy: { port: 3010, domains: ["docs.example"] } })
    expect(result.data[2]?.ownership).toBe("registry")
  })

  test("defaults docs to disabled for new service schemas and drafts", () => {
    const parsed = v.safeParse(projectServicesSchema, {
      schemaVersion: 2,
      owner: "alice",
      name: "catalog",
      services: [{ id: "docs", caddy: { port: 3010, domains: ["docs.example"] } }],
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.output.services[0]?.caddy?.docs).toBe(false)
    expect(projectServiceDraftFrom(undefined, "docs").docs).toBe(false)
  })

  test("preserves an existing external ownership when a legacy draft omits it", () => {
    const draft = { ...projectServiceDraftFrom(services[1], "api") }
    delete (draft as { ownership?: string }).ownership
    const result = projectServiceDraftApply(services, draft)

    expect(result).toMatchObject({ success: true, data: [{ id: "default" }, { id: "api", ownership: "external" }] })
  })

  test.each([
    ["", "app.example"],
    ["70000", "app.example"],
    ["3000", "  "],
  ])("rejects invalid port %p and domains %p", (port, domains) => {
    const result = projectServiceDraftApply(services, {
      ...projectServiceDraftFrom(services[0], "default"),
      port,
      domains,
    })

    expect(result.success).toBe(false)
  })
})
