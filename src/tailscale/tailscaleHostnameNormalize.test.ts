import { describe, expect, test } from "bun:test"
import { tailscaleHostnameNormalize } from "./tailscaleHostnameNormalize.js"

describe("tailscaleHostnameNormalize", () => {
  test("lowercases and strips one trailing dot", () => {
    expect(tailscaleHostnameNormalize("App.Wonder1.DE.")).toBe("app.wonder1.de")
  })

  test("accepts multi-level exact hosts", () => {
    expect(tailscaleHostnameNormalize("api.preview.sales.wonder1.de")).toBe("api.preview.sales.wonder1.de")
  })

  test("rejects wildcards, single labels, and malformed input", () => {
    for (const value of [
      "*.wonder1.de",
      "wonder1.*.de",
      "localhost",
      "",
      "  ",
      " spaced.wonder1.de",
      "bad..wonder1.de",
      "-bad.wonder1.de",
      "bad-.wonder1.de",
      42,
      undefined,
      null,
      {},
    ]) {
      expect(tailscaleHostnameNormalize(value)).toBeUndefined()
    }
  })

  test("rejects overlong names", () => {
    expect(tailscaleHostnameNormalize(`${"a".repeat(64)}.wonder1.de`)).toBeUndefined()
    expect(tailscaleHostnameNormalize(`${"a".repeat(250)}.de`)).toBeUndefined()
  })
})
