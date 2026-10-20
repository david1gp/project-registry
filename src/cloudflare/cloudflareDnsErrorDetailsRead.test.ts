import { describe, expect, test } from "bun:test"
import { cloudflareDnsErrorDataCreate } from "./cloudflareDnsErrorDataCreate.js"
import { cloudflareDnsErrorDetailsRead } from "./cloudflareDnsErrorDetailsRead.js"

describe("cloudflareDnsErrorDetailsRead", () => {
  test("reads the safe operation, status, and Cloudflare code", async () => {
    const error = {
      errorData: cloudflareDnsErrorDataCreate({
        operation: "record-create",
        statusCode: 200,
        body: { success: false, errors: [{ code: 8105, message: "upstream detail" }] },
      }),
      statusCode: 200,
    }
    expect(cloudflareDnsErrorDetailsRead(error)).toEqual({
      operation: "record-create",
      statusCode: 200,
      cloudflareCode: 8105,
    })
  })

  test("prefers the typed status while redacting hostile error metadata", async () => {
    const hostile = "cf-api-token-xyz-999"
    const details = cloudflareDnsErrorDetailsRead({
      errorData: JSON.stringify({
        operation: "record-list",
        statusCode: 503,
        cloudflareCode: 9103,
        message: `leak ${hostile} must not survive`,
        token: hostile,
        errors: [{ code: 1, message: hostile }],
      }),
      statusCode: 429,
    })
    expect(details).toEqual({ operation: "record-list", statusCode: 429, cloudflareCode: 9103 })
    expect(JSON.stringify(details)).not.toContain(hostile)
    expect(JSON.stringify(details)).not.toContain("must not survive")
  })

  test("rejects invalid fields and non-allowlisted operations", async () => {
    expect(cloudflareDnsErrorDetailsRead({})).toEqual({})
    expect(cloudflareDnsErrorDetailsRead({ errorData: null, statusCode: 200 })).toEqual({ statusCode: 200 })
    expect(cloudflareDnsErrorDetailsRead({ errorData: "not-json", statusCode: 200 })).toEqual({ statusCode: 200 })
    expect(cloudflareDnsErrorDetailsRead({ errorData: "[]", statusCode: 200 })).toEqual({ statusCode: 200 })
    for (const operation of ["zone-settings", "zaraz-disable", "RECORD-LIST", "", null]) {
      expect(cloudflareDnsErrorDetailsRead({ errorData: JSON.stringify({ operation, statusCode: 200 }) })).toEqual({
        statusCode: 200,
      })
    }
    for (const statusCode of [99, 600, 200.5, "200", null]) {
      expect(
        cloudflareDnsErrorDetailsRead({ errorData: JSON.stringify({ operation: "record-list", statusCode }) }),
      ).toEqual({ operation: "record-list" })
    }
    for (const cloudflareCode of [0, -3, 1.5, "8105", null]) {
      expect(
        cloudflareDnsErrorDetailsRead({
          errorData: JSON.stringify({ operation: "record-list", statusCode: 200, cloudflareCode }),
        }),
      ).toEqual({ operation: "record-list", statusCode: 200 })
    }
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
      expect(cloudflareDnsErrorDetailsRead({ errorData: JSON.stringify({ operation }) })).toEqual({ operation })
    }
  })
})
