import { describe, expect, test } from "bun:test"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import {
  tailscaleSplitDnsAuthValidate,
  tailscaleSplitDnsMapGet,
  tailscaleSplitDnsMapPatch,
} from "./tailscaleSplitDnsRequest.js"

const auth = { tailnet: "example.com", apiKey: "tskey-api-secret", baseUrl: "https://api.tailscale.com/api/v2" }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("tailscaleSplitDnsAuthValidate", () => {
  test("builds the split-DNS endpoint without exposing the key", () => {
    const result = tailscaleSplitDnsAuthValidate(auth, "test")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.url).toBe("https://api.tailscale.com/api/v2/tailnet/example.com/dns/split-dns")
    expect(result.data.headers["accept"]).toBe("application/json")
    expect(typeof result.data.headers["authorization"]).toBe("string")
  })

  test("rejects missing credentials and non-https URLs", () => {
    expect(tailscaleSplitDnsAuthValidate({ ...auth, tailnet: " " }, "test").success).toBe(false)
    expect(tailscaleSplitDnsAuthValidate({ ...auth, apiKey: "has space" }, "test").success).toBe(false)
    expect(tailscaleSplitDnsAuthValidate({ ...auth, apiKey: "" }, "test").success).toBe(false)
    expect(tailscaleSplitDnsAuthValidate({ ...auth, baseUrl: "http://insecure/api" }, "test").success).toBe(false)
    expect(tailscaleSplitDnsAuthValidate({ ...auth, baseUrl: "https://user@host/api" }, "test").success).toBe(false)
    expect(tailscaleSplitDnsAuthValidate(null, "test").success).toBe(false)
  })
})

describe("tailscaleSplitDnsMapGet", () => {
  test("returns the map and maps HTTP failures without bodies", async () => {
    const endpoint = tailscaleSplitDnsAuthValidate(auth, "test")
    if (!endpoint.success) throw new Error("auth setup failed")
    const ok: TailscaleSplitDnsFetch = async () => jsonResponse({ "app.wonder1.de": ["100.122.200.114"] })
    const got = await tailscaleSplitDnsMapGet({ op: "test", endpoint: endpoint.data, fetch: ok })
    expect(got.success).toBe(true)

    const forbidden: TailscaleSplitDnsFetch = async () => jsonResponse({ message: "nope" }, 403)
    const denied = await tailscaleSplitDnsMapGet({ op: "test", endpoint: endpoint.data, fetch: forbidden })
    expect(denied.success).toBe(false)
    if (denied.success) return
    expect(denied.errorMessage).toContain("403")
    expect(denied.errorMessage).not.toContain("nope")
    expect(denied.errorData).not.toContain("nope")
  })

  test("rejects invalid maps and honors cancellation", async () => {
    const endpoint = tailscaleSplitDnsAuthValidate(auth, "test")
    if (!endpoint.success) throw new Error("auth setup failed")
    const invalid: TailscaleSplitDnsFetch = async () => jsonResponse({ "app.wonder1.de": null })
    expect((await tailscaleSplitDnsMapGet({ op: "test", endpoint: endpoint.data, fetch: invalid })).success).toBe(false)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await tailscaleSplitDnsMapGet({
      op: "test",
      endpoint: endpoint.data,
      fetch: async () => jsonResponse({}),
      signal: controller.signal,
    })
    expect(cancelled.success).toBe(false)
  })
})

describe("tailscaleSplitDnsMapPatch", () => {
  test("PATCHes merges only and never PUTs", async () => {
    const endpoint = tailscaleSplitDnsAuthValidate(auth, "test")
    if (!endpoint.success) throw new Error("auth setup failed")
    const calls: Array<{ method?: string; body: unknown }> = []
    const fetchImpl: TailscaleSplitDnsFetch = async (_input, init) => {
      calls.push({ method: init.method, body: JSON.parse(init.body as string) })
      return jsonResponse({ "app.wonder1.de": ["100.122.200.114"], "other.example.com": ["9.9.9.9"] })
    }
    const result = await tailscaleSplitDnsMapPatch({
      op: "test",
      endpoint: endpoint.data,
      body: { "app.wonder1.de": ["100.122.200.114"] },
      fetch: fetchImpl,
    })
    expect(result.success).toBe(true)
    expect(calls).toEqual([{ method: "PATCH", body: { "app.wonder1.de": ["100.122.200.114"] } }])
  })
})
