import { describe, expect, test } from "bun:test"
import { createResult, type Result } from "#result"
import { cloudflareZarazAutoInjectDisable } from "./cloudflareZarazAutoInjectDisable.js"

type Call = {
  path: string
  init: RequestInit
}

function envelope(result: unknown): unknown {
  return { success: true, result }
}

function configCreate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataLayer: false,
    debugKey: "debug",
    settings: { autoInjectScript: true, hideIPAddress: true, unknownFutureSetting: "keep" },
    tools: {},
    triggers: {},
    variables: {},
    unknownTopLevel: { nested: [1, 2, 3] },
    ...overrides,
  }
}

function requestCreate(
  handler: (path: string, init: RequestInit, calls: Call[]) => { status: number; body: unknown },
): { request: (path: string, init: RequestInit) => Promise<Result<{ status: number; body: unknown }>>; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    request: async (path, init) => {
      calls.push({ path, init })
      return createResult(handler(path, init, calls))
    },
  }
}

describe("cloudflareZarazAutoInjectDisable", () => {
  test("sends the full configuration with only autoInjectScript changed and verifies with read-back", async () => {
    const source = configCreate()
    let updated = false
    let putBody: unknown
    const { request, calls } = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/config")) {
        return {
          status: 200,
          body: envelope(updated ? configCreate({ settings: { autoInjectScript: false } }) : structuredClone(source)),
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    const wrapped = async (path: string, init: RequestInit) => {
      if (init.method === "PUT") {
        putBody = JSON.parse(String((init as { body: string }).body))
        updated = true
        return createResult({ status: 200, body: envelope(structuredClone(source)) })
      }
      return request(path, init)
    }

    const result = await cloudflareZarazAutoInjectDisable({ request: wrapped, zoneId: "zone-id" })

    expect(result).toMatchObject({ success: true, data: { action: "disabled" } })
    expect(putBody).toEqual({
      ...source,
      settings: { ...(source["settings"] as Record<string, unknown>), autoInjectScript: false },
    })
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.path}`)).toEqual([
      "GET /zones/zone-id/settings/zaraz/workflow",
      "GET /zones/zone-id/settings/zaraz/config",
      "GET /zones/zone-id/settings/zaraz/config",
    ])
  })

  test("makes no writes when automatic injection is already disabled", async () => {
    const { request, calls } = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/config")) {
        return { status: 200, body: envelope(configCreate({ settings: { autoInjectScript: false } })) }
      }
      throw new Error(`unexpected ${path}`)
    })

    const result = await cloudflareZarazAutoInjectDisable({ request, zoneId: "zone-id" })

    expect(result).toMatchObject({ success: true, data: { action: "already-disabled" } })
    expect(calls.every((call) => (call.init.method ?? "GET") === "GET")).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test("uses the secret-inclusive export when variables are present and fails when it is incomplete", async () => {
    const redacted = configCreate({ variables: { one: { name: "token", type: "secret" } } })
    const exported = configCreate({ variables: { one: { name: "token", type: "secret", value: "s3cret" } } })
    const exportedDisabled = configCreate({
      settings: { autoInjectScript: false },
      variables: { one: { name: "token", type: "secret", value: "s3cret" } },
    })
    let updated = false
    let putBody: unknown
    const { request } = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/export")) return { status: 200, body: envelope(structuredClone(exported)) }
      if (path.endsWith("/settings/zaraz/config")) {
        return { status: 200, body: envelope(structuredClone(updated ? exportedDisabled : redacted)) }
      }
      throw new Error(`unexpected ${path}`)
    })
    const wrapped = async (path: string, init: RequestInit) => {
      if (init.method === "PUT") {
        putBody = JSON.parse(String((init as { body: string }).body))
        updated = true
        return createResult({ status: 200, body: envelope(structuredClone(exported)) })
      }
      return request(path, init)
    }

    const result = await cloudflareZarazAutoInjectDisable({ request: wrapped, zoneId: "zone-id" })

    expect(result).toMatchObject({ success: true, data: { action: "disabled" } })
    expect(putBody).toEqual({
      ...exported,
      settings: { ...(exported["settings"] as Record<string, unknown>), autoInjectScript: false },
    })

    const failing = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/export")) return { status: 500, body: { success: false } }
      if (path.endsWith("/settings/zaraz/config")) return { status: 200, body: envelope(structuredClone(redacted)) }
      throw new Error(`unexpected ${path}`)
    })
    let puts = 0
    const failingWrapped = async (path: string, init: RequestInit) => {
      if (init.method === "PUT") puts += 1
      return failing.request(path, init)
    }
    const failed = await cloudflareZarazAutoInjectDisable({ request: failingWrapped, zoneId: "zone-id" })
    expect(failed.success).toBe(false)
    expect(puts).toBe(0)
  })

  test("refuses a secret-inclusive export that no longer matches nonsecret configuration", async () => {
    const current = configCreate({ variables: { one: { name: "token", type: "secret" } } })
    const staleExport = configCreate({
      settings: { autoInjectScript: true, hideIPAddress: false, unknownFutureSetting: "keep" },
      tools: { changed: { action: "stale" } },
      variables: { one: { name: "token", type: "secret", value: "not-logged" } },
    })
    const { request, calls } = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/export")) return { status: 200, body: envelope(staleExport) }
      if (path.endsWith("/settings/zaraz/config")) return { status: 200, body: envelope(current) }
      throw new Error(`unexpected ${path}`)
    })

    const result = await cloudflareZarazAutoInjectDisable({ request, zoneId: "zone-id" })

    expect(result.success).toBe(false)
    expect(calls.some((call) => call.init.method === "PUT")).toBe(false)
  })

  test("refuses a secret-inclusive export with reordered configuration arrays without writing", async () => {
    const current = configCreate({
      variables: { one: { name: "token", type: "secret" } },
      unknownTopLevel: { nested: [1, 2, 3] },
    })
    const reorderedExport = configCreate({
      variables: { one: { name: "token", type: "secret", value: "not-logged" } },
      unknownTopLevel: { nested: [2, 1, 3] },
    })
    const { request, calls } = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/export")) return { status: 200, body: envelope(reorderedExport) }
      if (path.endsWith("/settings/zaraz/config")) return { status: 200, body: envelope(current) }
      throw new Error(`unexpected ${path}`)
    })

    const result = await cloudflareZarazAutoInjectDisable({ request, zoneId: "zone-id" })

    expect(result.success).toBe(false)
    expect(calls.some((call) => call.init.method === "PUT")).toBe(false)
  })

  test("refuses preview workflow and surfaces GET, PUT, and read-back failures", async () => {
    const preview = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("preview") }
      throw new Error("preview workflow must stop before config reads")
    })
    const previewR = await cloudflareZarazAutoInjectDisable({ request: preview.request, zoneId: "zone-id" })
    expect(previewR.success).toBe(false)
    if (previewR.success) return
    expect(previewR.errorMessage).toContain("preview")
    expect(preview.calls).toHaveLength(1)

    const failingGet = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      return { status: 500, body: { success: false } }
    })
    let puts = 0
    const failingGetWrapped = async (path: string, init: RequestInit) => {
      if (init.method === "PUT") puts += 1
      return failingGet.request(path, init)
    }
    expect((await cloudflareZarazAutoInjectDisable({ request: failingGetWrapped, zoneId: "zone-id" })).success).toBe(
      false,
    )
    expect(puts).toBe(0)

    const failingPut = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/config")) return { status: 200, body: envelope(configCreate()) }
      throw new Error(`unexpected ${path}`)
    })
    const failingPutWrapped = async (path: string, init: RequestInit) => {
      if (init.method === "PUT") return createResult({ status: 500, body: { success: false } })
      return failingPut.request(path, init)
    }
    expect((await cloudflareZarazAutoInjectDisable({ request: failingPutWrapped, zoneId: "zone-id" })).success).toBe(
      false,
    )

    const failingReadback = requestCreate((path) => {
      if (path.endsWith("/settings/zaraz/workflow")) return { status: 200, body: envelope("realtime") }
      if (path.endsWith("/settings/zaraz/config")) return { status: 200, body: envelope(configCreate()) }
      throw new Error(`unexpected ${path}`)
    })
    let readbackCalls = 0
    const failingReadbackWrapped = async (path: string, init: RequestInit) => {
      if (init.method === "PUT") return createResult({ status: 200, body: envelope(configCreate()) })
      if (path.endsWith("/settings/zaraz/config")) {
        readbackCalls += 1
        if (readbackCalls > 1) return createResult({ status: 200, body: envelope(configCreate()) })
      }
      return failingReadback.request(path, init)
    }
    const readbackR = await cloudflareZarazAutoInjectDisable({ request: failingReadbackWrapped, zoneId: "zone-id" })
    expect(readbackR.success).toBe(false)
    if (readbackR.success) return
    expect(readbackR.errorMessage).toContain("read-back")
  })
})
