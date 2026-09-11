import { describe, expect, test } from "bun:test"
import type { ProjectService } from "../project/projectServiceSchema.js"
import { projectServicesPatchApply } from "./projectServicesPatchApply.js"

const caddy: NonNullable<ProjectService["caddy"]> = {
  port: 3000,
  domains: ["app.example"],
  path: "",
  access: "external",
  kind: "proxy",
  docs: true,
  browse: false,
  headerUp: {},
  disabled: false,
  denyDotfiles: false,
  spa: false,
}

const services: ProjectService[] = [
  { id: "default", units: [], caddy: { ...caddy } },
  { id: "api", units: ["api.service"], caddy: { ...caddy, port: 3001, domains: ["api.example"] } },
]

describe("projectServicesPatchApply", () => {
  test("patches only the selected service and preserves sibling services", () => {
    const result = projectServicesPatchApply(services, "api", { port: 3005, domains: ["api2.example"] })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data[0]).toEqual(services[0]!)
    expect(result.data[1]?.caddy).toMatchObject({ port: 3005, domains: ["api2.example"] })
    expect(result.data[1]?.units).toEqual(["api.service"])
  })

  test("adds a new service when port and domains are supplied", () => {
    const result = projectServicesPatchApply(services, "docs", { port: 3009, domains: ["docs.example"] })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toHaveLength(3)
    expect(result.data[2]).toMatchObject({ id: "docs", caddy: { port: 3009, domains: ["docs.example"] } })
  })

  test("rejects adding an unknown service without port and domains", () => {
    const result = projectServicesPatchApply(services, "docs", { spa: true })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("does not exist yet")
  })
})
