import { describe, expect, test } from "bun:test"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsRemove } from "./tailscaleSplitDnsRemove.js"

const auth = { tailnet: "example.com", apiKey: "tskey-api-secret", baseUrl: "https://api.tailscale.com/api/v2" }
const nodeAddress = "100.122.200.114"

function fetchCreate(map: Record<string, string[]>, calls: string[]): TailscaleSplitDnsFetch {
  const live = new Map(Object.entries(map))
  return (async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    calls.push(`${init.method ?? "GET"} ${url.pathname}`)
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
    }
    const body = JSON.parse(init.body as string) as Record<string, string[] | null>
    for (const [hostname, value] of Object.entries(body)) {
      if (value === null) live.delete(hostname)
      else live.set(hostname, value)
    }
    return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
  }) as TailscaleSplitDnsFetch
}

describe("tailscaleSplitDnsRemove", () => {
  test("clears owned entries, rereads, and records priors", async () => {
    const calls: string[] = []
    const writes = new Map<string, string>()
    const result = await tailscaleSplitDnsRemove({
      auth,
      hostnames: ["old.wonder1.de", "gone.wonder1.de"],
      nodeAddress,
      stateFile: "/tmp/state.json",
      stateWrite: async (path, content) => {
        writes.set(path, content)
      },
      fetch: fetchCreate({ "old.wonder1.de": [nodeAddress], "other.example.com": ["9.9.9.9"] }, calls),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.removed).toEqual(["old.wonder1.de"])
    expect(result.data.alreadyAbsent).toEqual(["gone.wonder1.de"])
    expect(calls).toEqual([
      "GET /api/v2/tailnet/example.com/dns/split-dns",
      "PATCH /api/v2/tailnet/example.com/dns/split-dns",
      "GET /api/v2/tailnet/example.com/dns/split-dns",
    ])
    const state = JSON.parse(writes.get("/tmp/state.json") ?? "{}") as {
      prior: Record<string, unknown>
      applied: Record<string, unknown>
    }
    expect(state.prior).toEqual({ "old.wonder1.de": [nodeAddress] })
    expect(state.applied).toEqual({ "old.wonder1.de": null })
    expect(JSON.stringify(result)).not.toContain("tskey-api-secret")
  })

  test("refuses drifted or foreign-owned entries", async () => {
    const calls: string[] = []
    const result = await tailscaleSplitDnsRemove({
      auth,
      hostnames: ["foreign.example.com"],
      nodeAddress,
      stateFile: "/tmp/state.json",
      stateWrite: async () => undefined,
      fetch: fetchCreate({ "foreign.example.com": ["9.9.9.9"] }, calls),
    })
    expect(result.success).toBe(false)
    expect(calls).toEqual(["GET /api/v2/tailnet/example.com/dns/split-dns"])
  })

  test("requires hostnames and a state writer", async () => {
    const fetchImpl = fetchCreate({}, [])
    expect(
      (
        await tailscaleSplitDnsRemove({
          auth,
          hostnames: [],
          nodeAddress,
          stateFile: "/tmp/state.json",
          stateWrite: async () => undefined,
          fetch: fetchImpl,
        })
      ).success,
    ).toBe(false)
    expect(
      (
        await tailscaleSplitDnsRemove({
          auth,
          hostnames: ["old.wonder1.de"],
          nodeAddress,
          stateFile: "",
          stateWrite: async () => undefined,
          fetch: fetchImpl,
        })
      ).success,
    ).toBe(false)
  })
})
