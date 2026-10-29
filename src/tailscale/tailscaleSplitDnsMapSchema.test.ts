import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { tailscaleSplitDnsMapSchema } from "./tailscaleSplitDnsMapSchema.js"

describe("tailscaleSplitDnsMapSchema", () => {
  test("accepts a domain to nameserver-list map", () => {
    const parsed = a.safeParse(tailscaleSplitDnsMapSchema, { "app.wonder1.de": ["100.122.200.114"] })
    expect(parsed.success).toBe(true)
  })

  test("rejects non-map bodies", () => {
    for (const value of [null, [], "map", { "app.wonder1.de": "100.122.200.114" }, { "app.wonder1.de": null }]) {
      expect(a.safeParse(tailscaleSplitDnsMapSchema, value).success).toBe(false)
    }
  })
})
