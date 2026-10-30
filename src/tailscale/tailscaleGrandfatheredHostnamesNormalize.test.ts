import { describe, expect, test } from "bun:test"
import { tailscaleGrandfatheredHostnamesNormalize } from "./tailscaleGrandfatheredHostnamesNormalize.js"

describe("tailscaleGrandfatheredHostnamesNormalize", () => {
  test("normalizes exact hostnames and drops duplicates", () => {
    expect(tailscaleGrandfatheredHostnamesNormalize(["wonder1.de", "EXAMPLE.com."])).toEqual([
      "wonder1.de",
      "example.com",
    ])
    expect(tailscaleGrandfatheredHostnamesNormalize(["wonder1.de", "wonder1.de"])).toEqual(["wonder1.de"])
    expect(tailscaleGrandfatheredHostnamesNormalize([])).toEqual([])
  })

  test("rejects wildcards, apex-relative names, and non-arrays", () => {
    expect(tailscaleGrandfatheredHostnamesNormalize(["*.wonder1.de"])).toBeUndefined()
    expect(tailscaleGrandfatheredHostnamesNormalize(["single"])).toBeUndefined()
    expect(tailscaleGrandfatheredHostnamesNormalize(["wonder1.de", 42])).toBeUndefined()
    expect(tailscaleGrandfatheredHostnamesNormalize("wonder1.de")).toBeUndefined()
    expect(tailscaleGrandfatheredHostnamesNormalize(undefined)).toBeUndefined()
  })
})
