import { describe, expect, test } from "bun:test"
import type { ProjectCanonical } from "../project/projectCanonicalSchema.js"
import type { ProjectService } from "../project/projectServiceSchema.js"
import { projectCliServiceRows } from "./projectCliServiceRows.js"

function project(services: ProjectCanonical["services"]): ProjectCanonical {
  return {
    schemaVersion: 2,
    owner: "leo",
    name: "app",
    type: "customer",
    order: Number.MAX_SAFE_INTEGER,
    services,
    labels: { team: "platform" },
  }
}

const caddy: NonNullable<ProjectService["caddy"]> = {
  port: 3000,
  domains: ["app.example"],
  path: "/srv/app",
  access: "external",
  kind: "proxy",
  docs: true,
  browse: false,
  headerUp: {},
  disabled: false,
  denyDotfiles: false,
  spa: false,
}

describe("projectCliServiceRows", () => {
  test("emits one row per service with its own stable ID, port, and domains", () => {
    const rows = projectCliServiceRows(
      project([
        { id: "default", units: [], caddy: { ...caddy } },
        { id: "api", units: ["app-api.service"], caddy: { ...caddy, port: 3001, domains: ["api.example"] } },
      ]),
    )

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => [row.service, row.port, row.domains])).toEqual([
      ["default", 3000, ["app.example"]],
      ["api", 3001, ["api.example"]],
    ])
    expect(rows[1]?.units).toEqual(["app-api.service"])
    expect(rows.every((row) => row.name === "app" && row.user === "leo")).toBe(true)
  })

  test("keeps a service row for a service without Caddy configuration", () => {
    const rows = projectCliServiceRows(project([{ id: "worker", units: ["w.service"], caddy: null }]))

    expect(rows).toEqual([expect.objectContaining({ service: "worker", port: undefined, domains: [], disabled: true })])
  })

  test("emits a single service-less row for a project without services", () => {
    const rows = projectCliServiceRows(project([]))

    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty("service")
  })
})
