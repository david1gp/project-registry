import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { tailscaleSplitDnsStateSchema } from "./tailscaleSplitDnsStateSchema.js"

describe("tailscaleSplitDnsStateSchema", () => {
  test("accepts apply and removal states", () => {
    const apply = a.safeParse(tailscaleSplitDnsStateSchema, {
      version: 1,
      tailnet: "example.com",
      nodeAddress: "100.122.200.114",
      savedAt: "2026-10-29T00:00:00.000Z",
      prior: { "app.wonder1.de": null },
      applied: { "app.wonder1.de": ["100.122.200.114"] },
    })
    expect(apply.success).toBe(true)
    const removal = a.safeParse(tailscaleSplitDnsStateSchema, {
      version: 1,
      tailnet: "example.com",
      nodeAddress: "100.122.200.114",
      savedAt: "2026-10-29T00:00:00.000Z",
      prior: { "old.wonder1.de": ["100.122.200.114"] },
      applied: { "old.wonder1.de": null },
    })
    expect(removal.success).toBe(true)
  })

  test("rejects corrupt states", () => {
    expect(
      a.safeParse(tailscaleSplitDnsStateSchema, {
        version: 2,
        tailnet: "example.com",
        nodeAddress: "100.122.200.114",
        savedAt: "now",
        prior: {},
        applied: {},
      }).success,
    ).toBe(false)
    expect(a.safeParse(tailscaleSplitDnsStateSchema, { version: 1 }).success).toBe(false)
  })
})
