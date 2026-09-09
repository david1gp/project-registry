import { describe, expect, test } from "bun:test"
import type { CloudflareDnsTrackedRecord } from "./CloudflareDnsTrackedRecord.js"
import { cloudflareDnsDeleteById } from "./cloudflareDnsDeleteById.js"

type Call = {
  url: URL
  init: RequestInit
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function record(overrides: Partial<CloudflareDnsTrackedRecord> = {}): CloudflareDnsTrackedRecord {
  return {
    zoneId: "zone-id",
    zoneName: "example.com",
    id: "record-id",
    name: "app.example.com",
    type: "A",
    content: "203.0.113.8",
    ttl: 300,
    proxied: false,
    projectKeys: [{ owner: "leo", name: "app" }],
    ...overrides,
  }
}

function fetchCreate(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input)
      calls.push({ url, init })
      return handler(url, init)
    },
  }
}

describe("cloudflareDnsDeleteById", () => {
  test("gets the tracked ID, verifies every managed field, then deletes by ID", async () => {
    const tracked = record()
    const mock = fetchCreate((_url, init) => {
      if (init.method === "GET") return json({ success: true, result: tracked })
      expect(init.method).toBe("DELETE")
      return json({ success: true, result: null })
    })

    const result = await cloudflareDnsDeleteById({ token: "secret-token", record: tracked, fetch: mock.fetch })

    expect(result).toEqual({ success: true, data: { action: "deleted", recordId: "record-id" } })
    expect(mock.calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "GET https://api.cloudflare.com/client/v4/zones/zone-id/dns_records/record-id",
      "DELETE https://api.cloudflare.com/client/v4/zones/zone-id/dns_records/record-id",
    ])
    expect(mock.calls[0]?.init.headers).toMatchObject({ authorization: "Bearer secret-token" })
  })

  test("treats an absent tracked ID as success without a DELETE", async () => {
    const mock = fetchCreate((_url, init) => {
      expect(init.method).toBe("GET")
      return new Response("not-json", { status: 404 })
    })

    const result = await cloudflareDnsDeleteById({ token: "token", record: record(), fetch: mock.fetch })

    expect(result).toEqual({ success: true, data: { action: "absent", recordId: "record-id" } })
    expect(mock.calls).toHaveLength(1)
  })

  test.each([
    ["name", { name: "other.example.com" }],
    ["type", { type: "AAAA" }],
    ["content", { content: "203.0.113.9" }],
    ["ttl", { ttl: 60 }],
    ["proxy state", { proxied: true }],
    ["ID", { id: "other-record-id" }],
  ])("refuses deletion when the current %s differs", async (_field, currentChanges) => {
    const tracked = record()
    const mock = fetchCreate((_url, init) => {
      expect(init.method).toBe("GET")
      return json({ success: true, result: { ...tracked, ...currentChanges } })
    })

    const result = await cloudflareDnsDeleteById({ token: "token", record: tracked, fetch: mock.fetch })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("verification failed")
    expect(mock.calls).toHaveLength(1)
  })

  test("redacts API errors and aborts a timed-out verification", async () => {
    const apiError = await cloudflareDnsDeleteById({
      token: "secret-token",
      record: record(),
      fetch: async () => json({ success: false, errors: [{ message: "secret-token upstream details" }] }, 503),
    })
    expect(apiError.success).toBe(false)
    if (apiError.success) return
    expect(apiError.errorMessage).toBe("Cloudflare DNS request failed (status 503)")
    expect(apiError.errorMessage).not.toContain("secret-token")

    let aborted = false
    const timeout = await cloudflareDnsDeleteById({
      token: "token",
      record: record(),
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
    expect(timeout.success).toBe(false)
    if (timeout.success) return
    expect(timeout.errorMessage).toContain("timed out")
    expect(aborted).toBe(true)
  })
})
