import { describe, expect, test } from "bun:test"
import { routeCheckProbe, type RouteCheckProbeDeps } from "./routeCheckProbe.js"

const healthy: RouteCheckProbeDeps = {
  dnsLookup: async () => ["100.122.200.114"],
  tlsHandshake: async () => ({ authorized: true, validTo: "Jan 18 15:54:26 2027 GMT", issuer: "YE2" }),
  httpFetch: async () => ({ status: 200, ms: 12 }),
}

describe("routeCheckProbe", () => {
  test("reports a healthy route with addresses, TLS identity, and HTTP status", async () => {
    const result = await routeCheckProbe("semesterkur-convex.leonardomora.de", healthy)
    expect(result).toMatchObject({
      success: true,
      data: {
        hostname: "semesterkur-convex.leonardomora.de",
        addresses: ["100.122.200.114"],
        tls: { authorized: true, validTo: "Jan 18 15:54:26 2027 GMT", issuer: "YE2" },
        httpStatus: 200,
        ok: true,
        error: null,
      },
    })
    if (!result.success) throw new Error("probe failed")
    expect(result.data.httpMs).toBe(12)
  })

  test("treats a non-2xx HTTP status as reachable when transport and TLS succeed", async () => {
    const result = await routeCheckProbe("semesterkur-api.leonardomora.de", {
      ...healthy,
      httpFetch: async () => ({ status: 404, ms: 9 }),
    })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("probe failed")
    expect(typeof result.data.httpMs).toBe("number")
    expect(result.data.httpStatus).toBe(404)
    expect(result.data.ok).toBe(true)
    expect(result.data.error).toBe(null)
  })

  test("marks an untrusted TLS handshake as not ok without an HTTPS attempt", async () => {
    let fetched = false
    const result = await routeCheckProbe("expired.example", {
      dnsLookup: async () => ["203.0.113.7"],
      tlsHandshake: async () => ({ authorized: false, validTo: "Jan 1 00:00:00 2020 GMT", issuer: "YE2" }),
      httpFetch: async () => {
        fetched = true
        return { status: 200, ms: 1 }
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("probe failed")
    expect(result.data.ok).toBe(false)
    expect(result.data.httpStatus).toBe(null)
    expect(result.data.error).toBe("TLS certificate is not trusted.")
    expect(fetched).toBe(false)
  })

  test("marks DNS failure as not ok with the resolver message", async () => {
    const result = await routeCheckProbe("missing.example", {
      ...healthy,
      dnsLookup: async () => {
        throw new Error("getaddrinfo ENOTFOUND missing.example")
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("probe failed")
    expect(result.data.ok).toBe(false)
    expect(result.data.addresses).toEqual([])
    expect(result.data.error).toBe("DNS resolution failed: getaddrinfo ENOTFOUND missing.example")
  })

  test("rejects an invalid hostname without probing", async () => {
    let lookedUp = false
    const result = await routeCheckProbe("   ", {
      ...healthy,
      dnsLookup: async () => {
        lookedUp = true
        return []
      },
    })
    expect(result.success).toBe(false)
    expect(lookedUp).toBe(false)
  })
})
