import { describe, expect, test } from "bun:test"
import { tailscaleSplitDnsErrorDetailsRead } from "./tailscaleSplitDnsErrorDetailsRead.js"

describe("tailscaleSplitDnsErrorDetailsRead", () => {
  test("reads operation and status", () => {
    expect(
      tailscaleSplitDnsErrorDetailsRead({
        errorData: JSON.stringify({ operation: "split-dns-patch", statusCode: 403 }),
      }),
    ).toEqual({ operation: "split-dns-patch", statusCode: 403 })
  })

  test("prefers the result status code and tolerates corrupt data", () => {
    expect(tailscaleSplitDnsErrorDetailsRead({ errorData: "not-json", statusCode: 429 })).toEqual({
      statusCode: 429,
    })
    expect(tailscaleSplitDnsErrorDetailsRead({})).toEqual({})
    expect(tailscaleSplitDnsErrorDetailsRead({ errorData: JSON.stringify({ operation: "nope" }) })).toEqual({})
  })
})
