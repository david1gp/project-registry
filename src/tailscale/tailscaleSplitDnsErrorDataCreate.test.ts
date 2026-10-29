import { describe, expect, test } from "bun:test"
import { tailscaleSplitDnsErrorDataCreate } from "./tailscaleSplitDnsErrorDataCreate.js"

describe("tailscaleSplitDnsErrorDataCreate", () => {
  test("serializes operation and status without a body", () => {
    const data = tailscaleSplitDnsErrorDataCreate({ operation: "split-dns-patch", statusCode: 403 })
    expect(JSON.parse(data)).toEqual({ operation: "split-dns-patch", statusCode: 403 })
    expect(data).not.toContain("body")
  })

  test("drops invalid status codes", () => {
    expect(JSON.parse(tailscaleSplitDnsErrorDataCreate({ operation: "request", statusCode: 99 }))).toEqual({
      operation: "request",
    })
    expect(JSON.parse(tailscaleSplitDnsErrorDataCreate({ operation: "request" }))).toEqual({
      operation: "request",
    })
  })
})
