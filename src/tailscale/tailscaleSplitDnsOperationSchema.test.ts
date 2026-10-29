import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { tailscaleSplitDnsOperationSchema } from "./tailscaleSplitDnsOperationSchema.js"

describe("tailscaleSplitDnsOperationSchema", () => {
  test("accepts the known split-DNS operations", () => {
    for (const operation of [
      "split-dns-read",
      "split-dns-plan",
      "split-dns-patch",
      "split-dns-verify",
      "state-read",
      "state-write",
      "request",
    ]) {
      expect(a.safeParse(tailscaleSplitDnsOperationSchema, operation).success).toBe(true)
    }
    expect(a.safeParse(tailscaleSplitDnsOperationSchema, "record-create").success).toBe(false)
  })
})
