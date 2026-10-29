import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import {
  projectPrivateTlsChallengeResolversDefault,
  projectPrivateTlsChallengeResolversValidate,
  projectPrivateTlsEnrollmentPlanCreate,
  projectPrivateTlsEnrollmentPrepare,
} from "./projectPrivateTlsEnrollment.js"

describe("projectPrivateTlsEnrollmentPlanCreate", () => {
  test("covers single-level names by wildcard and enrolls multi-level names per host", () => {
    const result = projectPrivateTlsEnrollmentPlanCreate("leo", [
      "checkout.wonder1.de",
      "api.preview.sales.wonder1.de",
      "cms.films.wonder1.de",
    ])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.owner).toBe("leo")
    expect(result.data.wildcardCovered).toEqual(["checkout.wonder1.de"])
    expect(result.data.enroll).toEqual(["api.preview.sales.wonder1.de", "cms.films.wonder1.de"])
    expect(result.data.hosts).toEqual([
      { hostname: "api.preview.sales.wonder1.de", zone: "wonder1.de", enrollment: "per-host" },
      { hostname: "checkout.wonder1.de", zone: "wonder1.de", enrollment: "wildcard" },
      { hostname: "cms.films.wonder1.de", zone: "wonder1.de", enrollment: "per-host" },
    ])
  })

  test("dedupes, normalizes, and sorts hostnames", () => {
    const result = projectPrivateTlsEnrollmentPlanCreate("david", [
      "B.App.david-siewert.com.",
      "b.app.david-siewert.com",
      " Z.david-siewert.com ",
    ])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.enroll).toEqual(["b.app.david-siewert.com"])
    expect(result.data.wildcardCovered).toEqual(["z.david-siewert.com"])
  })

  test("rejects cross-zone claims naming the allowed zones", () => {
    const result = projectPrivateTlsEnrollmentPlanCreate("fabian", ["x.wonder1.de"])
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("webflows.de")
  })

  test("rejects apex, wildcard, empty, and non-string hostnames", () => {
    expect(projectPrivateTlsEnrollmentPlanCreate("leo", ["wonder1.de"]).success).toBe(false)
    expect(projectPrivateTlsEnrollmentPlanCreate("leo", ["*.wonder1.de"]).success).toBe(false)
    expect(projectPrivateTlsEnrollmentPlanCreate("leo", ["  "]).success).toBe(false)
    expect(projectPrivateTlsEnrollmentPlanCreate("leo", [42]).success).toBe(false)
    expect(projectPrivateTlsEnrollmentPlanCreate("leo", "app.wonder1.de").success).toBe(false)
    expect(projectPrivateTlsEnrollmentPlanCreate("", ["app.wonder1.de"]).success).toBe(false)
    expect(projectPrivateTlsEnrollmentPlanCreate("nobody", ["app.wonder1.de"]).success).toBe(false)
  })

  test("accepts an empty hostname list as an empty plan", () => {
    const result = projectPrivateTlsEnrollmentPlanCreate("leo", [])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ owner: "leo", hosts: [], enroll: [], wildcardCovered: [] })
  })
})

describe("projectPrivateTlsChallengeResolversValidate", () => {
  test("accepts the public defaults", () => {
    expect([...projectPrivateTlsChallengeResolversDefault]).toEqual(["1.1.1.1", "8.8.8.8"])
    const result = projectPrivateTlsChallengeResolversValidate([...projectPrivateTlsChallengeResolversDefault])
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual(["1.1.1.1", "8.8.8.8"])
  })

  test("rejects the private listener, loopback, and non-IPv4 resolvers", () => {
    const nodeAddress = "100.122.200.114"
    const privateListener = projectPrivateTlsChallengeResolversValidate(["1.1.1.1", nodeAddress], {
      privateAddresses: [nodeAddress],
    })
    expect(privateListener.success).toBe(false)
    if (!privateListener.success) {
      expect(privateListener.errorMessage).toContain("private listener")
    }
    expect(projectPrivateTlsChallengeResolversValidate(["127.0.0.1"]).success).toBe(false)
    expect(projectPrivateTlsChallengeResolversValidate(["::1"]).success).toBe(false)
    expect(projectPrivateTlsChallengeResolversValidate(["dns.example.com"]).success).toBe(false)
    expect(projectPrivateTlsChallengeResolversValidate([]).success).toBe(false)
    expect(projectPrivateTlsChallengeResolversValidate(undefined).success).toBe(false)
    expect(projectPrivateTlsChallengeResolversValidate(["1.1.1.1"], { privateAddresses: [""] }).success).toBe(false)
  })
})

describe("projectPrivateTlsEnrollmentPrepare", () => {
  test("resolves the claiming owner's token for multi-level hosts", async () => {
    const asked: string[] = []
    const result = await projectPrivateTlsEnrollmentPrepare({
      owner: "david",
      hostnames: ["app.david-siewert.com", "api.preview.david-siewert.com"],
      credentialResolve: async (owner) => {
        asked.push(owner)
        return createResult(`${owner}-token`)
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.plan.enroll).toEqual(["api.preview.david-siewert.com"])
    expect(result.data.plan.wildcardCovered).toEqual(["app.david-siewert.com"])
    expect(result.data.resolvers).toEqual(["1.1.1.1", "8.8.8.8"])
    expect(result.data.token).toBe("david-token")
    expect(asked).toEqual(["david"])
  })

  test("skips the credential resolver when every name is wildcard-covered", async () => {
    let calls = 0
    const result = await projectPrivateTlsEnrollmentPrepare({
      owner: "leo",
      hostnames: ["checkout.wonder1.de"],
      credentialResolve: async () => {
        calls += 1
        return createResult("token")
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.plan.enroll).toEqual([])
    expect(result.data.token).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("passes a missing claiming-owner token through without logging it", async () => {
    const result = await projectPrivateTlsEnrollmentPrepare({
      owner: "leo",
      hostnames: ["api.preview.wonder1.de"],
      credentialResolve: async () => createResult(undefined),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.token).toBeUndefined()
  })

  test("rejects invalid claims, resolvers, and missing resolvers", async () => {
    const crossZone = await projectPrivateTlsEnrollmentPrepare({
      owner: "musa",
      hostnames: ["x.wonder1.de"],
      credentialResolve: async () => createResult("token"),
    })
    expect(crossZone.success).toBe(false)
    if (!crossZone.success) expect(crossZone.errorMessage).toContain("covux-design.de")

    const resolvers = await projectPrivateTlsEnrollmentPrepare({
      owner: "leo",
      hostnames: ["api.preview.wonder1.de"],
      resolvers: ["127.0.0.1"],
      credentialResolve: async () => createResult("token"),
    })
    expect(resolvers.success).toBe(false)

    const missing = await projectPrivateTlsEnrollmentPrepare({
      owner: "leo",
      hostnames: ["api.preview.wonder1.de"],
    } as unknown as Parameters<typeof projectPrivateTlsEnrollmentPrepare>[0])
    expect(missing.success).toBe(false)
  })
})
