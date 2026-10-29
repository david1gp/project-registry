import { describe, expect, test } from "bun:test"
import { tailscaleSplitDnsPlanCreate } from "./tailscaleSplitDnsPlanCreate.js"

const nodeAddress = "100.122.200.114"

describe("tailscaleSplitDnsPlanCreate", () => {
  test("plans only owned exact hostnames and ignores unrelated entries", () => {
    const result = tailscaleSplitDnsPlanCreate(
      {
        "app.wonder1.de": [nodeAddress],
        "other.example.com": ["9.9.9.9"],
      },
      { hostnames: ["app.wonder1.de", "new.wonder1.de", "new.wonder1.de"], nodeAddress },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.hostnames).toEqual(["app.wonder1.de", "new.wonder1.de"])
    expect(result.data.unchanged).toEqual(["app.wonder1.de"])
    expect(result.data.toApply).toEqual({ "new.wonder1.de": [nodeAddress] })
    expect(result.data.desired).toEqual({
      "app.wonder1.de": [nodeAddress],
      "new.wonder1.de": [nodeAddress],
    })
  })

  test("reapplies drifted owned entries", () => {
    const result = tailscaleSplitDnsPlanCreate(
      { "app.wonder1.de": ["9.9.9.9"] },
      {
        hostnames: ["app.wonder1.de"],
        nodeAddress,
      },
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.toApply).toEqual({ "app.wonder1.de": [nodeAddress] })
    expect(result.data.unchanged).toEqual([])
  })

  test("rejects wildcards, malformed hosts, and bad node addresses", () => {
    expect(tailscaleSplitDnsPlanCreate({}, { hostnames: ["*.wonder1.de"], nodeAddress }).success).toBe(false)
    expect(tailscaleSplitDnsPlanCreate({}, { hostnames: ["solo"], nodeAddress }).success).toBe(false)
    expect(tailscaleSplitDnsPlanCreate({}, { hostnames: ["app.wonder1.de"], nodeAddress: "not-an-ip" }).success).toBe(
      false,
    )
    expect(tailscaleSplitDnsPlanCreate({}, { hostnames: ["app.wonder1.de"], nodeAddress: "::1" }).success).toBe(false)
    expect(tailscaleSplitDnsPlanCreate(null as never, { hostnames: [], nodeAddress }).success).toBe(false)
  })
})
