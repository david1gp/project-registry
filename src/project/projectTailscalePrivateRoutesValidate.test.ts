import { describe, expect, test } from "bun:test"
import {
  projectTailscalePrivateRouteDomains,
  projectTailscalePrivateRoutesValidate,
} from "./projectTailscalePrivateRoutesValidate.js"

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

  test("grandfathers already-served private domains but validates new ones", () => {
    const legacy = { caddy: { port: 3000, domains: ["api.preview.akademie.contentoren.de"], networkVisibility: "private" } }
    expect(projectTailscalePrivateRouteDomains(legacy)).toEqual(["api.preview.akademie.contentoren.de"])
    // Unrelated edits keep the legacy claim working.
    expect(projectTailscalePrivateRoutesValidate(legacy, "leo", "op", ["api.preview.akademie.contentoren.de"]).success).toBe(
      true,
    )
    // Newly added out-of-zone domains are still rejected.
    const added = {
      caddy: {
        port: 3000,
        domains: ["api.preview.akademie.contentoren.de", "new.contentoren.de"],
        networkVisibility: "private",
      },
    }
    const addedR = projectTailscalePrivateRoutesValidate(added, "leo", "op", ["api.preview.akademie.contentoren.de"])
    expect(addedR.success).toBe(false)
    if (addedR.success) return
    expect(addedR.errorMessage).toContain("new.contentoren.de")
    // Newly privatized domains are not grandfathered either.
    const privatized = {
      caddy: { port: 3000, domains: ["new.contentoren.de"], networkVisibility: "private" },
    }
    expect(projectTailscalePrivateRoutesValidate(privatized, "leo", "op", []).success).toBe(false)
    // The upstream guard still applies to grandfathered routes.
    const badUpstream = {
      caddy: {
        port: 3000,
        domains: ["api.preview.akademie.contentoren.de"],
        networkVisibility: "private",
        upstream: "10.1.2.3",
      },
    }
    expect(projectTailscalePrivateRoutesValidate(badUpstream, "leo", "op", ["api.preview.akademie.contentoren.de"]).success).toBe(
      false,
    )
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
