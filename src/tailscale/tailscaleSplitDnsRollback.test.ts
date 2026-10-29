import { describe, expect, test } from "bun:test"
import type { TailscaleSplitDnsFetch } from "./TailscaleSplitDnsFetch.js"
import { tailscaleSplitDnsRollback } from "./tailscaleSplitDnsRollback.js"

const auth = { tailnet: "example.com", apiKey: "tskey-api-secret", baseUrl: "https://api.tailscale.com/api/v2" }
const nodeAddress = "100.122.200.114"

function stateFileContent(applied: Record<string, string[] | null>, prior: Record<string, string[] | null>): string {
  return JSON.stringify({
    version: 1,
    tailnet: "example.com",
    nodeAddress,
    savedAt: "2026-10-29T00:00:00.000Z",
    prior,
    applied,
  })
}

function fetchCreate(map: Record<string, string[]>, bodies: unknown[]): TailscaleSplitDnsFetch {
  const live = new Map(Object.entries(map))
  return (async (_input: string, init: RequestInit): Promise<Response> => {
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
    }
    const body = JSON.parse(init.body as string) as Record<string, string[] | null>
    bodies.push(body)
    for (const [hostname, value] of Object.entries(body)) {
      if (value === null) live.delete(hostname)
      else live.set(hostname, value)
    }
    return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
  }) as TailscaleSplitDnsFetch
}

describe("tailscaleSplitDnsRollback", () => {
  test("restores prior owned values via PATCH", async () => {
    const bodies: unknown[] = []
    const result = await tailscaleSplitDnsRollback({
      auth,
      stateFile: "/tmp/state.json",
      stateRead: async () => stateFileContent({ "new.wonder1.de": [nodeAddress] }, { "new.wonder1.de": ["9.9.9.9"] }),
      fetch: fetchCreate({ "new.wonder1.de": [nodeAddress] }, bodies),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.restored).toEqual(["new.wonder1.de"])
    expect(bodies).toEqual([{ "new.wonder1.de": ["9.9.9.9"] }])
    expect(JSON.stringify(result)).not.toContain("tskey-api-secret")
  })

  test("refuses concurrent external changes and foreign tailnets", async () => {
    const changed = await tailscaleSplitDnsRollback({
      auth,
      stateFile: "/tmp/state.json",
      stateRead: async () => stateFileContent({ "new.wonder1.de": [nodeAddress] }, { "new.wonder1.de": null }),
      fetch: fetchCreate({ "new.wonder1.de": ["9.9.9.9"] }, []),
    })
    expect(changed.success).toBe(false)

    const foreign = await tailscaleSplitDnsRollback({
      auth: { ...auth, tailnet: "other.example" },
      stateFile: "/tmp/state.json",
      stateRead: async () => stateFileContent({ "new.wonder1.de": [nodeAddress] }, { "new.wonder1.de": null }),
      fetch: fetchCreate({ "new.wonder1.de": [nodeAddress] }, []),
    })
    expect(foreign.success).toBe(false)

    const corrupt = await tailscaleSplitDnsRollback({
      auth,
      stateFile: "/tmp/state.json",
      stateRead: async () => "not-json",
      fetch: fetchCreate({}, []),
    })
    expect(corrupt.success).toBe(false)
  })
})
