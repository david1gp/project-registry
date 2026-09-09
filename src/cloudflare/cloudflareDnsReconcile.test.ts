import { describe, expect, test } from "bun:test"
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
  proxied = true,
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

describe("cloudflareDnsReconcile", () => {
  test("discovers the longest accessible co.uk zone and creates an A record", async () => {
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
    expect(createCall?.init.headers).toMatchObject({ authorization: "Bearer secret-token" })
    expect(JSON.parse(String(createCall?.init.body))).toEqual({
      type: "A",
      name: "app.eu.example.co.uk",
      content: "203.0.113.8",
      ttl: 1,
      proxied: true,
    })
  })

  test("updates a single exact record and skips an identical record", async () => {
    const existing = record("record-id", "app.example.com.", "A", "203.0.113.7", 300, false)
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
    expect(updateCall?.url.pathname).toBe("/client/v4/zones/zone-id/dns_records/record-id")

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
  })

  test("reports ambiguous same-type records without mutation", async () => {
    const mock = fetchCreate((url, _init) => {
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
  })
})
