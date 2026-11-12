import { describe, expect, test } from "bun:test"
import type { ProjectService } from "../project/projectServiceSchema.js"
import { projectServicesDevApply } from "./projectServicesDevApply.js"

const services: ProjectService[] = [
  { id: "web", units: [], caddy: null, ownership: "registry", dev: { command: "vite --port {port}" } },
  { id: "api", units: [], caddy: null, ownership: "registry" },
]

describe("projectServicesDevApply", () => {
  test("sets one service's dev command and leaves siblings untouched", () => {
    const result = projectServicesDevApply(services, "api", "bun run ./api.ts --port {port}")
    expect(result).toEqual({
      success: true,
      data: [services[0]!, { ...services[1]!, dev: { command: "bun run ./api.ts --port {port}" } }],
    })
  })

  test("clears the dev command with an explicit null so the daemon merge cannot restore it", () => {
    const result = projectServicesDevApply(services, "web", undefined, true)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data[0]).toHaveProperty("dev", null)
    expect(result.data[1]).toBe(services[1]!)
  })

  test("refuses an unknown service", () => {
    expect(projectServicesDevApply(services, "convex", "bun run dev").success).toBe(false)
  })
})
