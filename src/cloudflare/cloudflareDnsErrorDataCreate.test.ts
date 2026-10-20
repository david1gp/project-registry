import { describe, expect, test } from "bun:test"
import { cloudflareDnsErrorDataCreate } from "./cloudflareDnsErrorDataCreate.js"

describe("cloudflareDnsErrorDataCreate", () => {
  test("keeps only the operation for a bare stage", async () => {
    expect(cloudflareDnsErrorDataCreate({ operation: "request" })).toBe(JSON.stringify({ operation: "request" }))
  })

  test("keeps valid status and numeric Cloudflare codes while dropping messages", async () => {
    const hostile = "cf-api-token-xyz-999"
    const data = cloudflareDnsErrorDataCreate({
      operation: "record-list",
      statusCode: 503,
      body: { success: false, errors: [{ code: 8105, message: `leak ${hostile} must not survive` }] },
    })
    expect(JSON.parse(data)).toEqual({ operation: "record-list", statusCode: 503, cloudflareCode: 8105 })
    expect(data).not.toContain(hostile)
    expect(data).not.toContain("must not survive")
  })

  test("drops hostile metadata and invalid fields", async () => {
    const hostile = "secret-token-abc-123"
    const data = cloudflareDnsErrorDataCreate({
      operation: "zone-lookup",
      statusCode: 9999,
      body: {
        success: false,
        token: hostile,
        authorization: `Bearer ${hostile}`,
        message: hostile,
        errors: [
          { code: 0, message: hostile },
          { code: -5, message: hostile },
          { code: 1.5, message: hostile },
          { code: hostile, message: hostile },
          null,
          hostile,
        ],
      },
    })
    expect(JSON.parse(data)).toEqual({ operation: "zone-lookup" })
    expect(data).not.toContain(hostile)
  })

  test("accepts every allowlisted operation", async () => {
    for (const operation of [
      "zone-lookup",
      "record-list",
      "record-create",
      "record-update",
      "record-verify",
      "record-delete",
      "request",
    ] as const) {
      expect(JSON.parse(cloudflareDnsErrorDataCreate({ operation }))).toEqual({ operation })
    }
  })
})
