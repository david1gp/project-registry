import { describe, expect, test } from "bun:test"
import { cloudflareDnsErrorDetailsRead } from "./cloudflareDnsErrorDetailsRead.js"
import { cloudflareDnsReconcile } from "./cloudflareDnsReconcile.js"

type Call = {
  url: URL
  init: RequestInit
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function zoneResult(id = "zone-id", name = "example.com"): unknown {
  return { success: true, result: [{ id, name, status: "active" }] }
}

function recordResult(record: Record<string, unknown>): unknown {
  return { success: true, result: record }
}

function recordList(records: Array<Record<string, unknown>>): unknown {
  return { success: true, result: records }
}

function record(
  id: string,
  name: string,
  type: string,
  content: string,
  ttl = 1,
  proxied = false,
): Record<string, unknown> {
  return { id, name, type, content, ttl, proxied }
}

function fetchCreate(handler: (url: URL, init: RequestInit, calls: Call[]) => Response | Promise<Response>): {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input)
      calls.push({ url, init })
      return handler(url, init, calls)
    },
  }
}

function settingsPaths(calls: Call[]): string[] {
  return calls.filter((call) => call.url.pathname.includes("/settings/")).map((call) => call.url.pathname)
}

describe("cloudflareDnsReconcile", () => {
  test("discovers the longest accessible co.uk zone and creates an A record without settings calls", async () => {
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) {
        const name = url.searchParams.get("name")
        if (name === "example.co.uk") return json(zoneResult("uk-zone", "example.co.uk"))
        return json({ success: true, result: [] })
      }
      if (url.pathname.endsWith("/dns_records") && init?.method === "GET") return json(recordList([]))
      return json(recordResult(record("new-id", "app.eu.example.co.uk", "A", "203.0.113.8")))
    })

    const result = await cloudflareDnsReconcile({
      token: "secret-token",
      hostname: "app.eu.example.co.uk",
      address: "203.0.113.8",
      fetch: mock.fetch,
    })

    expect(result).toMatchObject({ success: true, data: { action: "created", zone: { id: "uk-zone" } } })
    expect(mock.calls.slice(0, 3).map((call) => call.url.searchParams.get("name"))).toEqual([
      "app.eu.example.co.uk",
      "eu.example.co.uk",
      "example.co.uk",
    ])
    const createCall = mock.calls[4]
    expect(createCall?.init.method).toBe("POST")
    expect(createCall?.url.toString()).toBe("https://api.cloudflare.com/client/v4/zones/uk-zone/dns_records")
    expect(createCall?.init.headers).toMatchObject({ authorization: "Bearer secret-token" })
    expect(JSON.parse(String(createCall?.init.body))).toEqual({
      type: "A",
      name: "app.eu.example.co.uk",
      content: "203.0.113.8",
      ttl: 1,
      proxied: false,
    })
    expect(settingsPaths(mock.calls)).toEqual([])
    expect(mock.calls.every((call) => call.init.method !== "PATCH")).toBe(true)
  })

  test("updates a proxied exact record to DNS-only and skips an identical record", async () => {
    const existing = record("record-id", "app.example.com.", "A", "203.0.113.8", 1, true)
    let records = [existing]
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) return json(zoneResult())
      if (url.pathname.endsWith("/dns_records") && init.method === "GET") return json(recordList(records))
      if (init.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const updated = record(
          "record-id",
          String(body.name),
          String(body.type),
          String(body.content),
          Number(body.ttl),
          Boolean(body.proxied),
        )
        records = [updated]
        return json(recordResult(updated))
      }
      throw new Error("unexpected mutation")
    })

    const updated = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: mock.fetch,
    })
    expect(updated).toMatchObject({ success: true, data: { action: "updated" } })
    const updateCall = mock.calls.find((call) => call.init.method === "PUT")
    expect(updateCall?.url.toString()).toBe("https://api.cloudflare.com/client/v4/zones/zone-id/dns_records/record-id")
    expect(JSON.parse(String(updateCall?.init.body))).toMatchObject({ proxied: false })
    expect(settingsPaths(mock.calls)).toEqual([])
    expect(mock.calls.find((call) => call.init.method === "PATCH")).toBeUndefined()

    const skipped = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com.",
      address: "203.0.113.8",
      fetch: mock.fetch,
    })
    expect(skipped).toMatchObject({ success: true, data: { action: "skipped" } })
    expect(mock.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1)
  })

  test("reconciles IPv6 as AAAA and does not mutate conflicts", async () => {
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) return json(zoneResult())
      if (url.pathname.endsWith("/dns_records") && init.method === "GET") {
        return json(recordList([record("cname-id", "app.example.com", "CNAME", "other.example.net")]))
      }
      throw new Error("mutation must not occur")
    })
    const conflict = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "2001:db8::8",
      fetch: mock.fetch,
    })
    expect(conflict.success).toBe(false)
    if (conflict.success) return
    expect(conflict.errorMessage).toContain("incompatible CNAME")
    expect(mock.calls.every((call) => call.init.method !== "POST" && call.init.method !== "PUT")).toBe(true)
    const details = cloudflareDnsErrorDetailsRead(conflict)
    expect(details.operation).toBe("record-list")
    expect(typeof details.statusCode).toBe("number")
  })

  test("reports ambiguous same-type records without mutation", async () => {
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) return json(zoneResult())
      if (url.pathname.endsWith("/dns_records")) {
        return json(
          recordList([
            record("one", "app.example.com", "A", "203.0.113.1"),
            record("two", "APP.EXAMPLE.COM.", "A", "203.0.113.2"),
          ]),
        )
      }
      throw new Error("mutation must not occur")
    })
    const result = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: mock.fetch,
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("ambiguous A")
    expect(mock.calls.every((call) => call.init.method !== "POST" && call.init.method !== "PUT")).toBe(true)
  })

  test("gives actionable messages for auth, permission, and rate-limit failures", async () => {
    const cases = [
      { status: 401, hint: "token" },
      { status: 403, hint: "DNS Edit" },
      { status: 429, hint: "rate limit" },
    ]
    for (const { status, hint } of cases) {
      const result = await cloudflareDnsReconcile({
        token: "token",
        hostname: "app.example.com",
        address: "203.0.113.8",
        fetch: async (input) => {
          const url = new URL(input)
          if (url.pathname.endsWith("/zones")) {
            return json({ success: false, errors: [{ code: 9103, message: "sensitive upstream detail" }] }, status)
          }
          throw new Error("DNS reconciliation must not run after an auth failure")
        },
      })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.errorMessage).toContain(hint)
      expect(result.statusCode).toBe(status)
      expect(result.errorMessage).not.toContain("sensitive upstream detail")
      const details = cloudflareDnsErrorDetailsRead(result)
      expect(details).toMatchObject({ operation: "zone-lookup", statusCode: status, cloudflareCode: 9103 })
    }
  })

  test("reports HTTP 200 success:false envelopes with operation and Cloudflare code", async () => {
    const result = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        if (url.pathname.endsWith("/dns_records")) {
          return json({ success: false, errors: [{ code: 8105, message: "sensitive upstream detail" }] })
        }
        throw new Error("unexpected request")
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("DNS record list")
    expect(result.statusCode).toBe(200)
    expect(JSON.stringify(result)).not.toContain("sensitive upstream detail")
    const details = cloudflareDnsErrorDetailsRead(result)
    expect(details).toMatchObject({ operation: "record-list", statusCode: 200, cloudflareCode: 8105 })
  })

  test("preserves status for non-JSON errors without retaining the body text", async () => {
    const result = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        return new Response("upstream exploded cf-token-abc123", { status: 503 })
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("Cloudflare DNS request failed (status 503)")
    expect(result.statusCode).toBe(503)
    expect(JSON.stringify(result)).not.toContain("cf-token-abc123")
    const details = cloudflareDnsErrorDetailsRead(result)
    expect(details).toMatchObject({ operation: "record-list", statusCode: 503 })
    expect(details.cloudflareCode).toBeUndefined()
  })

  test("redacts hostile token-shaped bodies and thrown exceptions", async () => {
    const hostile = "cf-api-token-xyz-999"
    const hostileResult = await cloudflareDnsReconcile({
      token: "real-token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        if (url.pathname.endsWith("/dns_records")) {
          return json({
            success: false,
            errors: [{ code: 1000, message: `leak ${hostile} must not survive` }],
          })
        }
        throw new Error("unexpected request")
      },
    })
    expect(hostileResult.success).toBe(false)
    if (!hostileResult.success) {
      expect(JSON.stringify(hostileResult)).not.toContain(hostile)
      expect(JSON.stringify(hostileResult)).not.toContain("must not survive")
      const details = cloudflareDnsErrorDetailsRead(hostileResult)
      expect(details).toMatchObject({ operation: "record-list", cloudflareCode: 1000 })
    }

    const thrownResult = await cloudflareDnsReconcile({
      token: "real-token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async () => {
        throw new Error(`network blew up ${hostile}`)
      },
    })
    expect(thrownResult.success).toBe(false)
    if (!thrownResult.success) {
      expect(thrownResult.errorMessage).toBe("Cloudflare DNS request failed")
      expect(JSON.stringify(thrownResult)).not.toContain(hostile)
      const details = cloudflareDnsErrorDetailsRead(thrownResult)
      expect(details.operation).toBe("zone-lookup")
    }
  })

  test("rejects malformed API responses and cancels a timed-out request", async () => {
    const malformed = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async () => json({ success: true, result: [{ id: "zone" }] }),
    })
    expect(malformed.success).toBe(false)

    let aborted = false
    const timedOut = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      timeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new Error("aborted"))
            },
            { once: true },
          )
        }),
    })
    expect(timedOut.success).toBe(false)
    if (timedOut.success) return
    expect(timedOut.errorMessage).toContain("timed out")
    expect(aborted).toBe(true)
    expect(cloudflareDnsErrorDetailsRead(timedOut)).toMatchObject({ operation: "zone-lookup" })
  })

  test("reports the failing stage for timeouts, cancellations, and network failures", async () => {
    const hangingFetch = () => async (_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    const hangingTimeout = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      timeoutMs: 5,
      fetch: hangingFetch(),
    })
    expect(hangingTimeout.success).toBe(false)
    if (!hangingTimeout.success) {
      expect(hangingTimeout.errorMessage).toContain("timed out")
      expect(cloudflareDnsErrorDetailsRead(hangingTimeout)).toMatchObject({ operation: "zone-lookup" })
    }

    const listTimeout = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      timeoutMs: 10,
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        return new Promise<Response>(() => undefined)
      },
    })
    expect(listTimeout.success).toBe(false)
    if (!listTimeout.success) {
      expect(listTimeout.errorMessage).toContain("timed out")
      expect(cloudflareDnsErrorDetailsRead(listTimeout)).toMatchObject({ operation: "record-list" })
    }

    const controller = new AbortController()
    const abortTimer = globalThis.setTimeout(() => controller.abort(), 10)
    try {
      const cancelled = await cloudflareDnsReconcile({
        token: "token",
        hostname: "app.example.com",
        address: "203.0.113.8",
        signal: controller.signal,
        fetch: async (input) => {
          const url = new URL(input)
          if (url.pathname.endsWith("/zones")) return json(zoneResult())
          return new Promise<Response>(() => undefined)
        },
      })
      expect(cancelled.success).toBe(false)
      if (!cancelled.success) {
        expect(cancelled.errorMessage).toContain("cancelled")
        expect(cloudflareDnsErrorDetailsRead(cancelled)).toMatchObject({ operation: "record-list" })
      }
    } finally {
      globalThis.clearTimeout(abortTimer)
    }

    const hostile = "cf-api-token-stage-999"
    const networkFailure = await cloudflareDnsReconcile({
      token: "real-token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        throw new Error(`record list network blew up ${hostile}`)
      },
    })
    expect(networkFailure.success).toBe(false)
    if (!networkFailure.success) {
      expect(networkFailure.errorMessage).toBe("Cloudflare DNS request failed")
      expect(JSON.stringify(networkFailure)).not.toContain(hostile)
      expect(cloudflareDnsErrorDetailsRead(networkFailure)).toMatchObject({ operation: "record-list" })
    }
  })
})
