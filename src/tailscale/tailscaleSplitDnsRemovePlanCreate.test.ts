import { describe, expect, test } from "bun:test"
import { tailscaleSplitDnsRemovePlanCreate } from "./tailscaleSplitDnsRemovePlanCreate.js"

const nodeAddress = "100.122.200.114"

describe("tailscaleSplitDnsRemovePlanCreate", () => {
  test("clears owned entries and skips absent ones", () => {
    const result = tailscaleSplitDnsRemovePlanCreate(
      { "old.wonder1.de": [nodeAddress], "other.example.com": ["9.9.9.9"] },
      ["old.wonder1.de", "gone.wonder1.de"],
      nodeAddress,
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.toRemove).toEqual({ "old.wonder1.de": null })
    expect(result.data.alreadyAbsent).toEqual(["gone.wonder1.de"])
  })

  test("refuses drifted or foreign-owned entries", () => {
    const drifted = tailscaleSplitDnsRemovePlanCreate(
      { "app.wonder1.de": ["9.9.9.9"] },
      ["app.wonder1.de"],
      nodeAddress,
    )
    expect(drifted.success).toBe(false)
    const multi = tailscaleSplitDnsRemovePlanCreate(
      { "app.wonder1.de": [nodeAddress, "9.9.9.9"] },
      ["app.wonder1.de"],
      nodeAddress,
    )
    expect(multi.success).toBe(false)
  })

  test("rejects empty, malformed, and non-owned input", () => {
    expect(tailscaleSplitDnsRemovePlanCreate({}, [], nodeAddress).success).toBe(false)
    expect(tailscaleSplitDnsRemovePlanCreate({}, ["*.wonder1.de"], nodeAddress).success).toBe(false)
    expect(tailscaleSplitDnsRemovePlanCreate({}, ["app.wonder1.de"], "not-an-ip").success).toBe(false)
  })
})
