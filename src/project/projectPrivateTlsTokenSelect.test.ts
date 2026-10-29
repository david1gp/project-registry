import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import { projectPrivateTlsTokenOwnerSelect, projectPrivateTlsTokenResolve } from "./projectPrivateTlsTokenSelect.js"

describe("projectPrivateTlsTokenOwnerSelect", () => {
  test("selects the claiming owner and zone for exact hosts", () => {
    const result = projectPrivateTlsTokenOwnerSelect("leo", "checkout.wonder1.de")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ owner: "leo", zone: "wonder1.de" })
  })

  test("selects multi-level names inside the owner zone", () => {
    const result = projectPrivateTlsTokenOwnerSelect("david", "api.preview.sales.david-siewert.com")
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ owner: "david", zone: "david-siewert.com" })
  })

  test("rejects cross-zone claims naming the allowed zones", () => {
    const result = projectPrivateTlsTokenOwnerSelect("fabian", "x.wonder1.de")
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("webflows.de")
  })

  test("rejects apex, wildcard, and missing owners", () => {
    expect(projectPrivateTlsTokenOwnerSelect("leo", "wonder1.de").success).toBe(false)
    expect(projectPrivateTlsTokenOwnerSelect("leo", "*.wonder1.de").success).toBe(false)
    expect(projectPrivateTlsTokenOwnerSelect("", "checkout.wonder1.de").success).toBe(false)
    expect(projectPrivateTlsTokenOwnerSelect("nobody", "checkout.wonder1.de").success).toBe(false)
  })
})

describe("projectPrivateTlsTokenResolve", () => {
  test("resolves the claiming owner's token, never a fallback", async () => {
    const asked: string[] = []
    const result = await projectPrivateTlsTokenResolve({
      owner: "david",
      hostname: "app.david-siewert.com",
      credentialResolve: async (owner) => {
        asked.push(owner)
        return createResult(owner === "david" ? "david-token" : "wrong-token")
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ owner: "david", zone: "david-siewert.com", token: "david-token" })
    expect(asked).toEqual(["david"])
  })

  test("resolves nothing for rejected claims", async () => {
    let calls = 0
    const result = await projectPrivateTlsTokenResolve({
      owner: "fabian",
      hostname: "x.wonder1.de",
      credentialResolve: async () => {
        calls += 1
        return createResult("token")
      },
    })
    expect(result.success).toBe(false)
    expect(calls).toBe(0)
  })

  test("passes missing tokens through and rejects invalid ones", async () => {
    const missing = await projectPrivateTlsTokenResolve({
      owner: "leo",
      hostname: "app.wonder1.de",
      credentialResolve: async () => createResult(undefined),
    })
    expect(missing.success).toBe(true)
    if (!missing.success) return
    expect(missing.data.token).toBeUndefined()

    const invalid = await projectPrivateTlsTokenResolve({
      owner: "leo",
      hostname: "app.wonder1.de",
      credentialResolve: async () => createResult(" padded "),
    })
    expect(invalid.success).toBe(false)
  })

  test("requires a credential resolver", async () => {
    const result = await projectPrivateTlsTokenResolve({
      owner: "leo",
      hostname: "app.wonder1.de",
    } as unknown as Parameters<typeof projectPrivateTlsTokenResolve>[0])
    expect(result.success).toBe(false)
  })
})
