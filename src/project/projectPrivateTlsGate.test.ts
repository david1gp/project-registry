import { describe, expect, test } from "bun:test"
import { createResult, createResultError, type PromiseResult } from "#result"
import {
  type ProjectPrivateTlsTrustProbe,
  projectPrivateTlsGateDecide,
  projectPrivateTlsGateStateCreate,
  projectPrivateTlsTrustedCheck,
} from "./projectPrivateTlsGate.js"

describe("projectPrivateTlsGateDecide", () => {
  const snapshot = {
    enrolled: ["api.preview.wonder1.de"],
    wildcardCovered: ["checkout.wonder1.de"],
    proven: ["api.preview.wonder1.de", "checkout.wonder1.de"],
  }

  test("serves names whose enrollment is proven", () => {
    const decided = projectPrivateTlsGateDecide({
      hostnames: ["api.preview.wonder1.de", "checkout.wonder1.de"],
      snapshot,
    })
    expect(decided.success).toBe(true)
    if (!decided.success) return
    expect(decided.data.allowed).toEqual(["api.preview.wonder1.de", "checkout.wonder1.de"])
    expect(decided.data.refused).toEqual([])
  })

  test("refuses enrolled names without a trusted-handshake proof", () => {
    const decided = projectPrivateTlsGateDecide({
      hostnames: ["api.preview.wonder1.de"],
      snapshot: { ...snapshot, proven: [] },
    })
    expect(decided.success).toBe(true)
    if (!decided.success) return
    expect(decided.data.allowed).toEqual([])
    expect(decided.data.refused).toHaveLength(1)
    expect(decided.data.refused[0]?.hostname).toBe("api.preview.wonder1.de")
    expect(decided.data.refused[0]?.reason).toContain("no proven trusted TLS handshake")
  })

  test("refuses unknown names that the tracker has not enrolled yet", () => {
    const decided = projectPrivateTlsGateDecide({
      hostnames: ["new.preview.wonder1.de"],
      snapshot,
    })
    expect(decided.success).toBe(true)
    if (!decided.success) return
    expect(decided.data.allowed).toEqual([])
    expect(decided.data.refused[0]?.reason).toContain("not enrolled")
  })

  test("wildcard coverage alone never serves without proof", () => {
    const decided = projectPrivateTlsGateDecide({
      hostnames: ["checkout.wonder1.de"],
      snapshot: { enrolled: [], wildcardCovered: ["checkout.wonder1.de"], proven: [] },
    })
    expect(decided.success).toBe(true)
    if (!decided.success) return
    expect(decided.data.allowed).toEqual([])
    expect(decided.data.refused).toHaveLength(1)
  })

  test("dedupes, sorts, and rejects empty or malformed input", () => {
    const decided = projectPrivateTlsGateDecide({
      hostnames: ["checkout.wonder1.de", "api.preview.wonder1.de", "checkout.wonder1.de"],
      snapshot,
    })
    expect(decided.success).toBe(true)
    if (!decided.success) return
    expect(decided.data.allowed).toEqual(["api.preview.wonder1.de", "checkout.wonder1.de"])

    expect(projectPrivateTlsGateDecide({ hostnames: [""], snapshot }).success).toBe(false)
    expect(projectPrivateTlsGateDecide({ hostnames: "nope", snapshot }).success).toBe(false)
    expect(projectPrivateTlsGateDecide({ hostnames: [], snapshot: undefined }).success).toBe(false)
    expect(
      projectPrivateTlsGateDecide({ hostnames: [], snapshot: { enrolled: "nope", wildcardCovered: [], proven: [] } })
        .success,
    ).toBe(false)
  })
})

describe("projectPrivateTlsTrustedCheck", () => {
  test("passes when every hostname probes trusted", async () => {
    const probed: string[] = []
    const checked = await projectPrivateTlsTrustedCheck({
      probe: async (hostname) => {
        probed.push(hostname)
        return createResult("trusted")
      },
      hostnames: ["a.wonder1.de", "b.wonder1.de"],
    })
    expect(checked.success).toBe(true)
    expect(probed).toEqual(["a.wonder1.de", "b.wonder1.de"])
  })

  test("refuses immediately by default and names the untrusted hostname", async () => {
    let calls = 0
    const checked = await projectPrivateTlsTrustedCheck({
      probe: async () => {
        calls += 1
        return createResultError("probe", "connection failed")
      },
      hostnames: ["flaky.wonder1.de"],
    })
    expect(checked.success).toBe(false)
    if (checked.success) return
    expect(checked.errorMessage).toContain("flaky.wonder1.de")
    expect(calls).toBe(1)
  })

  test("retries within the wait window and passes once issuance lands", async () => {
    let now = 0
    let calls = 0
    const checked = await projectPrivateTlsTrustedCheck({
      probe: async () => {
        calls += 1
        return calls < 3 ? createResultError("probe", "not yet") : createResult("trusted")
      },
      hostnames: ["lagging.wonder1.de"],
      waitMs: 10_000,
      pollMs: 2_000,
      clock: () => now,
      sleep: async (delayMs) => {
        now += delayMs
      },
    })
    expect(checked.success).toBe(true)
    expect(calls).toBe(3)
  })

  test("refuses after the wait window and treats probe failures as untrusted", async () => {
    let now = 0
    const checked = await projectPrivateTlsTrustedCheck({
      probe: async () => {
        throw new Error("boom")
      },
      hostnames: ["down.wonder1.de"],
      waitMs: 4_000,
      pollMs: 5_000,
      clock: () => now,
      sleep: async (delayMs) => {
        now += delayMs
      },
    })
    expect(checked.success).toBe(false)
    if (checked.success) return
    expect(checked.errorMessage).toContain("down.wonder1.de")

    const malformed = await projectPrivateTlsTrustedCheck({
      probe: (() =>
        Promise.resolve({
          success: true,
          data: "untrusted",
        }) as unknown as PromiseResult<"trusted">) as ProjectPrivateTlsTrustProbe,
      hostnames: ["odd.wonder1.de"],
    })
    expect(malformed.success).toBe(false)
  })

  test("passes vacuously with no hostnames and rejects malformed options", async () => {
    const checked = await projectPrivateTlsTrustedCheck({ probe: async () => createResult("trusted"), hostnames: [] })
    expect(checked.success).toBe(true)
    expect((await projectPrivateTlsTrustedCheck({ probe: undefined as never, hostnames: [] })).success).toBe(false)
    expect(
      (await projectPrivateTlsTrustedCheck({ probe: async () => createResult("trusted"), waitMs: -1, hostnames: [] }))
        .success,
    ).toBe(false)
  })
})

describe("projectPrivateTlsGateStateCreate", () => {
  test("starts empty, publishes atomically, and hands out copies", () => {
    const state = projectPrivateTlsGateStateCreate()
    expect(state.current()).toEqual({ enrolled: [], wildcardCovered: [], proven: [] })

    state.update({
      enrolled: ["b.wonder1.de", "a.wonder1.de", "a.wonder1.de"],
      wildcardCovered: ["shop.wonder1.de"],
      proven: ["a.wonder1.de"],
    })
    const first = state.current()
    expect(first).toEqual({
      enrolled: ["a.wonder1.de", "b.wonder1.de"],
      wildcardCovered: ["shop.wonder1.de"],
      proven: ["a.wonder1.de"],
    })

    ;(first.enrolled as string[]).push("mutated.wonder1.de")
    expect(state.current().enrolled).toEqual(["a.wonder1.de", "b.wonder1.de"])

    state.update({ enrolled: [], wildcardCovered: [], proven: [] })
    expect(state.current()).toEqual({ enrolled: [], wildcardCovered: [], proven: [] })
  })
})
