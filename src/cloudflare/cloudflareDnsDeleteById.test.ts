import { describe, expect, test } from "bun:test"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { CloudflareDnsTrackedRecord } from "./CloudflareDnsTrackedRecord.js"
import { cloudflareDnsDeleteById } from "./cloudflareDnsDeleteById.js"
import { cloudflareDnsErrorDetailsRead } from "./cloudflareDnsErrorDetailsRead.js"

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

  test("checks the current desired state after verification and immediately before deletion", async () => {
    const operations: string[] = []
    const tracked = record()
    const mock = fetchCreate((_url, init) => {
      operations.push(init.method ?? "GET")
      return json({ success: true, result: tracked })
    })
    const result = await cloudflareDnsDeleteById({
      token: "token",
      record: tracked,
      fetch: mock.fetch,
      beforeDelete: async () => {
        operations.push("guard")
        return createResult(true)
      },
    })
    expect(result.success).toBe(true)
    expect(operations).toEqual(["GET", "guard", "DELETE"])
  })

  test.each([
    { name: "denied", beforeDelete: async () => createResult(false) },
    { name: "failed", beforeDelete: async () => createResultError("guard", "secret-token upstream") },
    {
      name: "thrown",
      beforeDelete: async () => {
        throw new Error("secret-token upstream")
      },
    },
    { name: "timed out", beforeDelete: () => new Promise<never>(() => {}) },
  ] satisfies { name: string; beforeDelete: () => PromiseResult<boolean> }[])(
    "does not delete when the final desired-state guard is $name",
    async ({ beforeDelete }) => {
      const tracked = record()
      const mock = fetchCreate(() => json({ success: true, result: tracked }))
      const result = await cloudflareDnsDeleteById({
        token: "secret-token",
        record: tracked,
        fetch: mock.fetch,
        beforeDelete,
        timeoutMs: 10,
      })
      expect(result.success).toBe(false)
      expect(mock.calls.map((call) => call.init.method)).toEqual(["GET"])
      expect(JSON.stringify(result)).not.toContain("secret-token")
      expect(JSON.stringify(result)).not.toContain("upstream")
    },
  )

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
    const details = cloudflareDnsErrorDetailsRead(result)
    expect(details.operation).toBe("record-verify")
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
    expect(JSON.stringify(apiError)).not.toContain("upstream details")
    expect(apiError.statusCode).toBe(503)
    const apiDetails = cloudflareDnsErrorDetailsRead(apiError)
    expect(apiDetails).toMatchObject({ operation: "record-verify", statusCode: 503 })

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

  test("gives actionable messages and safe diagnostics for auth and permission failures", async () => {
    for (const { status, hint } of [
      { status: 401, hint: "token" },
      { status: 403, hint: "DNS Edit" },
    ]) {
      const result = await cloudflareDnsDeleteById({
        token: "token",
        record: record(),
        fetch: async () =>
          json({ success: false, errors: [{ code: 9103, message: "sensitive upstream detail" }] }, status),
      })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.errorMessage).toContain(hint)
      expect(result.statusCode).toBe(status)
      expect(JSON.stringify(result)).not.toContain("sensitive upstream detail")
      const details = cloudflareDnsErrorDetailsRead(result)
      expect(details).toMatchObject({ operation: "record-verify", statusCode: status, cloudflareCode: 9103 })
    }
  })

  test("reports the failing stage for timeouts, cancellations, and network failures", async () => {
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
    if (!timeout.success) {
      expect(timeout.errorMessage).toContain("timed out")
      expect(aborted).toBe(true)
      expect(cloudflareDnsErrorDetailsRead(timeout)).toMatchObject({ operation: "record-verify" })
    }

    const controller = new AbortController()
    controller.abort()
    const cancelled = await cloudflareDnsDeleteById({
      token: "token",
      record: record(),
      signal: controller.signal,
      fetch: async () => {
        throw new Error("fetch must not run after cancellation")
      },
    })
    expect(cancelled.success).toBe(false)
    if (!cancelled.success) {
      expect(cancelled.errorMessage).toContain("cancelled")
      expect(JSON.stringify(cancelled)).not.toContain("fetch must not run")
    }

    const hostile = "cf-api-token-stage-999"
    const networkFailure = await cloudflareDnsDeleteById({
      token: "real-token",
      record: record(),
      fetch: async (_url, init) => {
        if (init.method === "GET") return json({ success: true, result: record() })
        throw new Error(`delete network blew up ${hostile}`)
      },
    })
    expect(networkFailure.success).toBe(false)
    if (!networkFailure.success) {
      expect(networkFailure.errorMessage).toBe("Cloudflare DNS request failed")
      expect(JSON.stringify(networkFailure)).not.toContain(hostile)
      expect(cloudflareDnsErrorDetailsRead(networkFailure)).toMatchObject({ operation: "record-delete" })
    }
  })

  test("reports success:false delete envelopes and redacts hostile bodies", async () => {
    const hostile = "cf-api-token-xyz-999"
    const result = await cloudflareDnsDeleteById({
      token: "real-token",
      record: record(),
      fetch: async (_url, init) => {
        if (init.method === "GET") return json({ success: true, result: record() })
        return json({ success: false, errors: [{ code: 8105, message: `leak ${hostile} must not survive` }] })
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("DNS record deletion")
    expect(result.statusCode).toBe(200)
    expect(JSON.stringify(result)).not.toContain(hostile)
    expect(JSON.stringify(result)).not.toContain("must not survive")
    const details = cloudflareDnsErrorDetailsRead(result)
    expect(details).toMatchObject({ operation: "record-delete", statusCode: 200, cloudflareCode: 8105 })
  })
})
