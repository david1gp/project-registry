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

function emailObfuscationResult(value = "off"): unknown {
  return { success: true, result: { id: "email_obfuscation", value } }
}

function zarazConfigResult(autoInjectScript: boolean): unknown {
  return {
    success: true,
    result: {
      dataLayer: false,
      debugKey: "debug-key",
      settings: { autoInjectScript, hideIPAddress: true },
      tools: {},
      triggers: {},
      variables: {},
      unknownFutureField: "keep",
    },
  }
}

function zarazWorkflowResult(value = "realtime"): unknown {
  return { success: true, result: value }
}

function zarazAlreadyDisabled(url: URL): Response | undefined {
  if (url.pathname.endsWith("/settings/zaraz/workflow")) return json(zarazWorkflowResult())
  if (url.pathname.endsWith("/settings/zaraz/config")) return json(zarazConfigResult(false))
  return undefined
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

describe("cloudflareDnsReconcile", () => {
  test("discovers the longest accessible co.uk zone and creates an A record", async () => {
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) {
        const name = url.searchParams.get("name")
        if (name === "example.co.uk") return json(zoneResult("uk-zone", "example.co.uk"))
        return json({ success: true, result: [] })
      }
      if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult())
      const zarazAlreadyDisabledResponse = zarazAlreadyDisabled(url)
      if (zarazAlreadyDisabledResponse !== undefined) return zarazAlreadyDisabledResponse
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
    const createCall = mock.calls[7]
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
    const emailObfuscationCall = mock.calls[3]
    expect(emailObfuscationCall?.init.method).toBe("PATCH")
    expect(emailObfuscationCall?.url.toString()).toBe(
      "https://api.cloudflare.com/client/v4/zones/uk-zone/settings/email_obfuscation",
    )
    expect(emailObfuscationCall?.init.headers).toMatchObject({ authorization: "Bearer secret-token" })
    expect(JSON.parse(String(emailObfuscationCall?.init.body))).toEqual({ value: "off" })
    expect(mock.calls[4]?.init.method).toBe("GET")
    expect(mock.calls[4]?.url.toString()).toBe(
      "https://api.cloudflare.com/client/v4/zones/uk-zone/settings/zaraz/workflow",
    )
    expect(mock.calls[5]?.init.method).toBe("GET")
    expect(mock.calls[5]?.url.toString()).toBe(
      "https://api.cloudflare.com/client/v4/zones/uk-zone/settings/zaraz/config",
    )
  })

  test("updates a proxied exact record to DNS-only and skips an identical record", async () => {
    const existing = record("record-id", "app.example.com.", "A", "203.0.113.8", 1, true)
    let records = [existing]
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) return json(zoneResult())
      if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult())
      const zarazAlreadyDisabledResponse = zarazAlreadyDisabled(url)
      if (zarazAlreadyDisabledResponse !== undefined) return zarazAlreadyDisabledResponse
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
    const obfuscationCalls = mock.calls.filter((call) => call.init.method === "PATCH")
    expect(obfuscationCalls).toHaveLength(1)
    expect(obfuscationCalls[0]?.url.toString()).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone-id/settings/email_obfuscation",
    )
    expect(JSON.parse(String(obfuscationCalls[0]?.init.body))).toEqual({ value: "off" })
    expect(mock.calls.indexOf(obfuscationCalls[0]!) < mock.calls.indexOf(updateCall!)).toBe(true)

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
      if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult())
      const zarazAlreadyDisabledResponse = zarazAlreadyDisabled(url)
      if (zarazAlreadyDisabledResponse !== undefined) return zarazAlreadyDisabledResponse
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
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) return json(zoneResult())
      if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult())
      const zarazAlreadyDisabledResponse = zarazAlreadyDisabled(url)
      if (zarazAlreadyDisabledResponse !== undefined) return zarazAlreadyDisabledResponse
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

  test("disables Zaraz automatic injection after email obfuscation and before DNS updates", async () => {
    const source = {
      dataLayer: false,
      debugKey: "debug-key",
      settings: { autoInjectScript: true, hideIPAddress: true },
      tools: {},
      triggers: {},
      variables: {},
      unknownFutureField: "keep",
    }
    let updated = false
    let putBody: unknown
    const mock = fetchCreate((url, init) => {
      if (url.pathname.endsWith("/zones")) return json(zoneResult())
      if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult())
      if (url.pathname.endsWith("/settings/zaraz/workflow")) return json(zarazWorkflowResult())
      if (url.pathname.endsWith("/settings/zaraz/config") && init.method !== "PUT") {
        return json({
          success: true,
          result: updated
            ? { ...source, settings: { autoInjectScript: false, hideIPAddress: true } }
            : structuredClone(source),
        })
      }
      if (url.pathname.endsWith("/settings/zaraz/config") && init.method === "PUT") {
        putBody = JSON.parse(String(init.body))
        updated = true
        return json({ success: true, result: structuredClone(source) })
      }
      if (url.pathname.endsWith("/dns_records") && init.method === "GET") return json(recordList([]))
      return json(recordResult(record("new-id", "app.example.com", "A", "203.0.113.8")))
    })

    const result = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: mock.fetch,
    })

    expect(result).toMatchObject({ success: true, data: { action: "created" } })
    expect(putBody).toEqual({ ...source, settings: { autoInjectScript: false, hideIPAddress: true } })
    const methodPaths = mock.calls.map((call) => `${call.init.method} ${call.url.pathname}`)
    expect(methodPaths).toEqual([
      "GET /client/v4/zones",
      "GET /client/v4/zones",
      "PATCH /client/v4/zones/zone-id/settings/email_obfuscation",
      "GET /client/v4/zones/zone-id/settings/zaraz/workflow",
      "GET /client/v4/zones/zone-id/settings/zaraz/config",
      "PUT /client/v4/zones/zone-id/settings/zaraz/config",
      "GET /client/v4/zones/zone-id/settings/zaraz/config",
      "GET /client/v4/zones/zone-id/dns_records",
      "POST /client/v4/zones/zone-id/dns_records",
    ])
  })

  test("surfaces Zaraz failures before DNS reconciliation", async () => {
    for (const zaraz of [
      async (input: string, init: RequestInit) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult())
        if (url.pathname.endsWith("/settings/zaraz/workflow")) return json(zarazWorkflowResult(), 500)
        throw new Error("DNS reconciliation must not run after a Zaraz failure")
      },
      async (input: string, init: RequestInit) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult())
        if (url.pathname.endsWith("/settings/zaraz/workflow")) return json(zarazWorkflowResult("preview"))
        throw new Error("DNS reconciliation must not run after a Zaraz failure")
      },
    ]) {
      const result = await cloudflareDnsReconcile({
        token: "token",
        hostname: "app.example.com",
        address: "203.0.113.8",
        fetch: zaraz,
      })
      expect(result.success).toBe(false)
    }
  })

  test("surfaces email obfuscation failures before DNS reconciliation", async () => {
    const failingStatus = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async (input, init) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        if (url.pathname.endsWith("/settings/email_obfuscation")) return json({ success: false }, 500)
        throw new Error("DNS reconciliation must not run after a settings failure")
      },
    })
    expect(failingStatus.success).toBe(false)

    const malformedSetting = await cloudflareDnsReconcile({
      token: "token",
      hostname: "app.example.com",
      address: "203.0.113.8",
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname.endsWith("/zones")) return json(zoneResult())
        if (url.pathname.endsWith("/settings/email_obfuscation")) return json(emailObfuscationResult("on"))
        throw new Error("DNS reconciliation must not run after a settings failure")
      },
    })
    expect(malformedSetting.success).toBe(false)
    if (malformedSetting.success) return
    expect(malformedSetting.errorMessage).toContain("Cloudflare API response was invalid")
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
