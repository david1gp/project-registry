import { describe, expect, test } from "bun:test"
import { tailscaleSplitDnsRead } from "./tailscaleSplitDnsRead.js"

const auth = { tailnet: "example.com", apiKey: "tskey-api-secret", baseUrl: "https://api.tailscale.com/api/v2" }

describe("tailscaleSplitDnsRead", () => {
  test("returns the split-DNS map", async () => {
    const result = await tailscaleSplitDnsRead({
      auth,
      fetch: async () => new Response(JSON.stringify({ "app.wonder1.de": ["100.122.200.114"] }), { status: 200 }),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ "app.wonder1.de": ["100.122.200.114"] })
  })

  test("rejects invalid options and surfaces API failures without credentials", async () => {
    expect((await tailscaleSplitDnsRead({ auth: { ...auth, apiKey: "" } })).success).toBe(false)
    expect((await tailscaleSplitDnsRead(null as never)).success).toBe(false)
    const result = await tailscaleSplitDnsRead({
      auth,
      fetch: async () => new Response(JSON.stringify({ message: "denied" }), { status: 401 }),
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("401")
    expect(JSON.stringify(result)).not.toContain("tskey-api-secret")
    expect(JSON.stringify(result)).not.toContain("denied")
  })
})
