import { describe, expect, test } from "bun:test"
import { projectTailscaleZoneClaimValidate, projectTailscaleZonePolicy } from "./projectTailscaleZonePolicy.js"

describe("projectTailscaleZonePolicy", () => {
  test("pins one exclusive zone per owner", () => {
    expect(projectTailscaleZonePolicy).toEqual({
      leo: ["wonder1.de"],
      david: ["david-siewert.com"],
      fabian: ["webflows.de"],
      musa: ["covux-design.de"],
    })
  })
})

describe("projectTailscaleZoneClaimValidate", () => {
  test("accepts exact hosts inside the owner's zone and returns the owning zone", () => {
    expect(projectTailscaleZoneClaimValidate("leo", "checkout.wonder1.de")).toMatchObject({
      success: true,
      data: "wonder1.de",
    })
    expect(projectTailscaleZoneClaimValidate("david", "app.david-siewert.com")).toMatchObject({
      success: true,
      data: "david-siewert.com",
    })
    expect(projectTailscaleZoneClaimValidate("fabian", "shop.webflows.de")).toMatchObject({
      success: true,
      data: "webflows.de",
    })
    expect(projectTailscaleZoneClaimValidate("musa", "site.covux-design.de")).toMatchObject({
      success: true,
      data: "covux-design.de",
    })
  })

  test("accepts multi-level names and tolerates case, whitespace, and trailing dots", () => {
    expect(projectTailscaleZoneClaimValidate("leo", "api.preview.sales.wonder1.de")).toMatchObject({
      success: true,
      data: "wonder1.de",
    })
    expect(projectTailscaleZoneClaimValidate("leo", "  Checkout.Wonder1.De. ")).toMatchObject({
      success: true,
      data: "wonder1.de",
    })
  })

  test("rejects cross-zone claims naming the owner's allowed zones", () => {
    const result = projectTailscaleZoneClaimValidate("fabian", "x.wonder1.de")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("webflows.de")
    expect(result.errorMessage).toContain("x.wonder1.de")
  })

  test("rejects lookalike suffixes that are not inside the zone", () => {
    for (const hostname of ["evilwonder1.de", "wonder1.de.evil.com", "wonder1.de-fake.example"]) {
      const result = projectTailscaleZoneClaimValidate("leo", hostname)
      expect(result.success).toBe(false)
    }
  })

  test("rejects apex and bare-zone names", () => {
    const apex = projectTailscaleZoneClaimValidate("leo", "wonder1.de")
    expect(apex.success).toBe(false)
    if (apex.success) return
    expect(apex.errorMessage).toContain("apex")
    expect(apex.errorMessage).toContain("wonder1.de")

    const trailingDot = projectTailscaleZoneClaimValidate("leo", "wonder1.de.")
    expect(trailingDot.success).toBe(false)

    const foreignApex = projectTailscaleZoneClaimValidate("fabian", "wonder1.de")
    expect(foreignApex.success).toBe(false)
    if (foreignApex.success) return
    expect(foreignApex.errorMessage).toContain("webflows.de")
  })

  test("rejects wildcard inputs", () => {
    const result = projectTailscaleZoneClaimValidate("leo", "*.wonder1.de")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("wildcard")
    expect(result.errorMessage).toContain("wonder1.de")
  })

  test("rejects private claims for owners without Tailscale zones", () => {
    const result = projectTailscaleZoneClaimValidate("alice", "site.example")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("no Tailscale zones")
  })

  test("rejects missing owners and empty hostnames", () => {
    expect(projectTailscaleZoneClaimValidate("  ", "x.wonder1.de").success).toBe(false)
    expect(projectTailscaleZoneClaimValidate("leo", "   ").success).toBe(false)
    expect(projectTailscaleZoneClaimValidate("leo", 42).success).toBe(false)
    expect(projectTailscaleZoneClaimValidate("leo", undefined).success).toBe(false)
  })
})
