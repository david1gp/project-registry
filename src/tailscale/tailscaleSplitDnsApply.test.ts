import { describe, expect, test } from "bun:test"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsApply } from "./tailscaleSplitDnsApply.js"

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

describe("tailscaleSplitDnsApply", () => {
  test("patches only owned hostnames and records priors for rollback", async () => {
    const calls: string[] = []
    const writes = new Map<string, string>()
    const result = await tailscaleSplitDnsApply({
      auth,
      hostnames: ["new.wonder1.de", "current.wonder1.de"],
      nodeAddress,
      stateFile: "/tmp/state.json",
      stateWrite: async (path, content) => {
        writes.set(path, content)
      },
      fetch: fetchCreate({ "current.wonder1.de": [nodeAddress], "other.example.com": ["9.9.9.9"] }, calls),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.applied).toEqual({ "new.wonder1.de": [nodeAddress] })
    expect(result.data.alreadyCurrent).toEqual(["current.wonder1.de"])
    expect(calls).toEqual([
      "GET /api/v2/tailnet/example.com/dns/split-dns",
      "PATCH /api/v2/tailnet/example.com/dns/split-dns",
    ])
    const state = JSON.parse(writes.get("/tmp/state.json") ?? "{}") as {
      tailnet: string
      prior: Record<string, unknown>
      applied: Record<string, unknown>
    }
    expect(state.tailnet).toBe("example.com")
    expect(state.prior).toEqual({ "new.wonder1.de": null })
    expect(state.applied).toEqual({ "new.wonder1.de": [nodeAddress] })
    expect(JSON.stringify(result)).not.toContain("tskey-api-secret")
  })

  test("skips the PATCH when everything is current and writes no state", async () => {
    const calls: string[] = []
    let writes = 0
    const result = await tailscaleSplitDnsApply({
      auth,
      hostnames: ["current.wonder1.de"],
      nodeAddress,
      stateFile: "/tmp/state.json",
      stateWrite: async () => {
        writes += 1
      },
      fetch: fetchCreate({ "current.wonder1.de": [nodeAddress] }, calls),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.applied).toEqual({})
    expect(calls).toEqual(["GET /api/v2/tailnet/example.com/dns/split-dns"])
    expect(writes).toBe(0)
  })

  test("requires a state writer and refuses invalid desired state", async () => {
    const calls: string[] = []
    const fetchImpl = fetchCreate({}, calls)
    expect(
      (
        await tailscaleSplitDnsApply({
          auth,
          hostnames: ["*.wonder1.de"],
          nodeAddress,
          stateFile: "/tmp/state.json",
          stateWrite: async () => undefined,
          fetch: fetchImpl,
        })
      ).success,
    ).toBe(false)
    expect(
      (
        await tailscaleSplitDnsApply({
          auth,
          hostnames: ["new.wonder1.de"],
          nodeAddress,
          stateFile: "",
          stateWrite: async () => undefined,
          fetch: fetchImpl,
        })
      ).success,
    ).toBe(false)
    expect(
      (
        await tailscaleSplitDnsApply({
          auth: { ...auth, apiKey: "" },
          hostnames: ["new.wonder1.de"],
          nodeAddress,
          stateFile: "/tmp/state.json",
          stateWrite: async () => undefined,
          fetch: fetchImpl,
        })
      ).success,
    ).toBe(false)
  })

  test("fails when the update is not reflected", async () => {
    const result = await tailscaleSplitDnsApply({
      auth,
      hostnames: ["new.wonder1.de"],
      nodeAddress,
      stateFile: "/tmp/state.json",
      stateWrite: async () => undefined,
      fetch: (async (input: string, init: RequestInit): Promise<Response> => {
        void input
        if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({}), { status: 200 })
        return new Response(JSON.stringify({}), { status: 200 })
      }) as TailscaleSplitDnsFetch,
    })
    expect(result.success).toBe(false)
  })
})
