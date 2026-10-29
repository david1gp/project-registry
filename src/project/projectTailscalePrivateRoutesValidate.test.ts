import { describe, expect, test } from "bun:test"
import { projectTailscalePrivateRoutesValidate } from "./projectTailscalePrivateRoutesValidate.js"

describe("projectTailscalePrivateRoutesValidate", () => {
  test("passes empty and malformed inputs", () => {
    expect(projectTailscalePrivateRoutesValidate(undefined, "leo").success).toBe(true)
    expect(projectTailscalePrivateRoutesValidate(null, "leo").success).toBe(true)
    expect(projectTailscalePrivateRoutesValidate([], "leo").success).toBe(true)
    expect(projectTailscalePrivateRoutesValidate({ owner: "leo" }, "leo").success).toBe(true)
    expect(projectTailscalePrivateRoutesValidate({ caddy: "broken" }, "leo").success).toBe(true)
    expect(projectTailscalePrivateRoutesValidate({ caddy: null, services: ["api.service"] }, "leo").success).toBe(true)
  })

  test("passes public, disabled, and domain-less private routes", () => {
    expect(
      projectTailscalePrivateRoutesValidate(
        { caddy: { domains: ["site.example"], networkVisibility: "public" } },
        "leo",
      ).success,
    ).toBe(true)
    expect(
      projectTailscalePrivateRoutesValidate(
        { caddy: { domains: ["site.example"], networkVisibility: "private", disabled: true } },
        "leo",
      ).success,
    ).toBe(true)
    expect(projectTailscalePrivateRoutesValidate({ caddy: { networkVisibility: "private" } }, "leo").success).toBe(true)
  })

  test("accepts in-zone private domains on legacy and canonical inputs", () => {
    expect(
      projectTailscalePrivateRoutesValidate(
        { caddy: { port: 3000, domains: ["app.wonder1.de"], networkVisibility: "private" } },
        "leo",
      ).success,
    ).toBe(true)
    expect(
      projectTailscalePrivateRoutesValidate(
        {
          schemaVersion: 2,
          services: [
            { id: "web", caddy: { port: 3000, domains: ["x.webflows.de"], networkVisibility: "private" } },
            { id: "worker", caddy: null },
          ],
        },
        "fabian",
      ).success,
    ).toBe(true)
  })

  test("rejects cross-zone private domains with the allowed zones", () => {
    const result = projectTailscalePrivateRoutesValidate(
      { caddy: { port: 3000, domains: ["x.wonder1.de"], networkVisibility: "private" } },
      "fabian",
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("webflows.de")
  })

  test("rejects non-loopback upstreams on private routes", () => {
    const result = projectTailscalePrivateRoutesValidate(
      {
        schemaVersion: 2,
        services: [
          {
            id: "worker",
            caddy: { port: 3000, domains: ["w.wonder1.de"], networkVisibility: "private", upstream: "10.1.2.3" },
          },
        ],
      },
      "leo",
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("worker")
    expect(result.errorMessage).toContain("tailnet-wide")
  })
})
