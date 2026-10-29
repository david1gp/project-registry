import { describe, expect, test } from "bun:test"
import {
  projectPrivateTlsAutomationRender,
  projectPrivateTlsTokenEnvVarsDefault,
} from "./projectPrivateTlsAutomation.js"

describe("projectPrivateTlsAutomationRender", () => {
  test("renders per-zone DNS-01 policies plus the automate loader for multi-level names", () => {
    const rendered = projectPrivateTlsAutomationRender({
      claims: [
        { owner: "leo", hostnames: ["api.preview.wonder1.de", "cms.films.wonder1.de"] },
        { owner: "david", hostnames: ["api.preview.david-siewert.com"] },
      ],
    })
    expect(rendered.success).toBe(true)
    if (!rendered.success) return
    expect(rendered.data.enrolled).toEqual([
      "api.preview.david-siewert.com",
      "api.preview.wonder1.de",
      "cms.films.wonder1.de",
    ])
    expect(rendered.data.wildcardCovered).toEqual([])
    expect(rendered.data.tls.certificates.automate).toEqual([
      "api.preview.david-siewert.com",
      "api.preview.wonder1.de",
      "cms.films.wonder1.de",
    ])
    expect(rendered.data.tls.automation.policies).toEqual([
      {
        subjects: ["api.preview.wonder1.de", "cms.films.wonder1.de"],
        issuers: [
          {
            module: "acme",
            challenges: {
              dns: {
                provider: { name: "cloudflare", api_token: "{env.CLOUDFLARE_API_TOKEN}" },
                resolvers: ["1.1.1.1:53", "8.8.8.8:53"],
              },
            },
          },
        ],
      },
      {
        subjects: ["api.preview.david-siewert.com"],
        issuers: [
          {
            module: "acme",
            challenges: {
              dns: {
                provider: { name: "cloudflare", api_token: "{env.CLOUDFLARE_API_TOKEN_DAVID_ZONES}" },
                resolvers: ["1.1.1.1:53", "8.8.8.8:53"],
              },
            },
          },
        ],
      },
    ])
  })

  test("skips single-level wildcard-covered names: no per-host policy, no automate entry", () => {
    const rendered = projectPrivateTlsAutomationRender({
      claims: [{ owner: "leo", hostnames: ["checkout.wonder1.de", "api.preview.wonder1.de"] }],
    })
    expect(rendered.success).toBe(true)
    if (!rendered.success) return
    expect(rendered.data.enrolled).toEqual(["api.preview.wonder1.de"])
    expect(rendered.data.wildcardCovered).toEqual(["checkout.wonder1.de"])
    expect(rendered.data.tls.certificates.automate).toEqual(["api.preview.wonder1.de"])
    expect(rendered.data.tls.automation.policies).toHaveLength(1)
    expect(rendered.data.tls.automation.policies[0]?.subjects).toEqual(["api.preview.wonder1.de"])
    expect(JSON.stringify(rendered.data.tls)).not.toContain("checkout.wonder1.de")
  })

  test("renders an empty section when every name is wildcard-covered", () => {
    const rendered = projectPrivateTlsAutomationRender({
      claims: [{ owner: "leo", hostnames: ["checkout.wonder1.de"] }],
    })
    expect(rendered.success).toBe(true)
    if (!rendered.success) return
    expect(rendered.data.tls).toEqual({ automation: { policies: [] }, certificates: { automate: [] } })
    expect(rendered.data.wildcardCovered).toEqual(["checkout.wonder1.de"])
  })

  test("shares one policy across zones with the same credential", () => {
    const rendered = projectPrivateTlsAutomationRender({
      claims: [
        { owner: "leo", hostnames: ["api.preview.wonder1.de"] },
        { owner: "david", hostnames: ["api.preview.david-siewert.com"] },
      ],
      tokenEnvVars: { leo: "CLOUDFLARE_API_TOKEN_SHARED", david: "CLOUDFLARE_API_TOKEN_SHARED" },
    })
    expect(rendered.success).toBe(true)
    if (!rendered.success) return
    expect(rendered.data.tls.automation.policies).toHaveLength(1)
    expect(rendered.data.tls.automation.policies[0]?.subjects).toEqual([
      "api.preview.david-siewert.com",
      "api.preview.wonder1.de",
    ])
  })

  test("rejects cross-zone, apex, and wildcard inputs without rendering", () => {
    const crossZone = projectPrivateTlsAutomationRender({
      claims: [{ owner: "fabian", hostnames: ["api.preview.wonder1.de"] }],
    })
    expect(crossZone.success).toBe(false)
    if (crossZone.success) return
    expect(crossZone.errorMessage).toContain("webflows.de")

    const apex = projectPrivateTlsAutomationRender({ claims: [{ owner: "leo", hostnames: ["wonder1.de"] }] })
    expect(apex.success).toBe(false)

    const wildcard = projectPrivateTlsAutomationRender({
      claims: [{ owner: "leo", hostnames: ["*.wonder1.de"] }],
    })
    expect(wildcard.success).toBe(false)
  })

  test("refuses the private listener and loopback as challenge resolvers", () => {
    const listener = projectPrivateTlsAutomationRender({
      claims: [{ owner: "leo", hostnames: ["api.preview.wonder1.de"] }],
      resolvers: ["1.1.1.1", "100.122.200.114"],
      privateAddresses: ["100.122.200.114"],
    })
    expect(listener.success).toBe(false)
    if (listener.success) return
    expect(listener.errorMessage).toContain("100.122.200.114")

    const loopback = projectPrivateTlsAutomationRender({
      claims: [{ owner: "leo", hostnames: ["api.preview.wonder1.de"] }],
      resolvers: ["127.0.0.1"],
    })
    expect(loopback.success).toBe(false)
  })

  test("references tokens as {env.*} placeholders and never embeds literals", () => {
    const token = "cf-test-token-literal-must-never-render"
    const rendered = projectPrivateTlsAutomationRender({
      claims: [{ owner: "leo", hostnames: ["api.preview.wonder1.de"] }],
    })
    expect(rendered.success).toBe(true)
    if (!rendered.success) return
    const serialized = JSON.stringify(rendered.data)
    expect(serialized).toContain("{env.CLOUDFLARE_API_TOKEN}")
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('api_token":"cf-')
  })

  test("fails closed when an owner has no token environment binding", () => {
    const rendered = projectPrivateTlsAutomationRender({
      claims: [{ owner: "fabian", hostnames: ["api.preview.webflows.de"] }],
    })
    expect(rendered.success).toBe(false)
    if (rendered.success) return
    expect(rendered.errorMessage).toContain('owner "fabian"')
  })

  test("rejects invalid bindings, duplicate cross-owner claims, and malformed input", () => {
    const invalidBinding = projectPrivateTlsAutomationRender({
      claims: [{ owner: "leo", hostnames: ["api.preview.wonder1.de"] }],
      tokenEnvVars: { leo: "lowercase-invalid" },
    })
    expect(invalidBinding.success).toBe(false)

    const notObject = projectPrivateTlsAutomationRender({ claims: [{ owner: "leo", hostnames: [] }], tokenEnvVars: [] })
    expect(notObject.success).toBe(false)

    const notClaims = projectPrivateTlsAutomationRender({ claims: "nope" })
    expect(notClaims.success).toBe(false)

    const duplicateCrossOwner = projectPrivateTlsAutomationRender({
      claims: [
        { owner: "leo", hostnames: ["api.preview.wonder1.de"] },
        { owner: "david", hostnames: ["api.preview.wonder1.de"] },
      ],
    })
    expect(duplicateCrossOwner.success).toBe(false)

    const duplicateSameOwner = projectPrivateTlsAutomationRender({
      claims: [
        { owner: "leo", hostnames: ["api.preview.wonder1.de"] },
        { owner: "leo", hostnames: ["api.preview.wonder1.de"] },
      ],
    })
    expect(duplicateSameOwner.success).toBe(true)
    if (!duplicateSameOwner.success) return
    expect(duplicateSameOwner.data.enrolled).toEqual(["api.preview.wonder1.de"])
  })

  test("renders nothing for empty claims and exposes the default bindings", () => {
    const rendered = projectPrivateTlsAutomationRender({ claims: [] })
    expect(rendered.success).toBe(true)
    if (!rendered.success) return
    expect(rendered.data.tls).toEqual({ automation: { policies: [] }, certificates: { automate: [] } })
    expect(projectPrivateTlsTokenEnvVarsDefault.leo).toBe("CLOUDFLARE_API_TOKEN")
    expect(projectPrivateTlsTokenEnvVarsDefault.david).toBe("CLOUDFLARE_API_TOKEN_DAVID_ZONES")
    expect(projectPrivateTlsTokenEnvVarsDefault.fabian).toBeUndefined()
    expect(projectPrivateTlsTokenEnvVarsDefault.musa).toBeUndefined()
  })
})
