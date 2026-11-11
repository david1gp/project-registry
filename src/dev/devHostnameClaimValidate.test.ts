import { describe, expect, test } from "bun:test"
import { projectNormalize } from "../project/projectNormalize.js"
import type { Project } from "../project/projectSchema.js"
import { devHostnameClaimValidate } from "./devHostnameClaimValidate.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"

function projectWithDomain(owner: string, name: string, domain: string): Project {
  const result = projectNormalize({ owner, name, caddy: { port: 3000, domains: [domain] } })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

function lease(owner: string, name: string, hostname: string): DevLeaseRecord {
  return {
    projectKey: { owner, name },
    user: owner,
    port: 4300,
    unit: `dev-${owner}-${name}.service`,
    hostname,
    state: "active",
    ttlMs: 14_400_000,
    lastSeenAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
  }
}

describe("devHostnameClaimValidate", () => {
  test("derives the hostname for a user without a zone-policy entry", () => {
    const result = devHostnameClaimValidate({ user: "tim", project: "akademie", projects: [], leases: [] })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe("tim-akademie.wonder1.de")
  })

  test("rejects hostnames with reserved service prefixes", () => {
    for (const user of ["t3code-bot", "opencode-agent"]) {
      const result = devHostnameClaimValidate({ user, project: "site", projects: [], leases: [] })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.code).toBe("request.invalid")
    }
  })

  test("rejects collisions with existing project row domains", () => {
    const result = devHostnameClaimValidate({
      user: "mitarbeiter",
      project: "intranet",
      projects: [projectWithDomain("leo", "intranet", "mitarbeiter-intranet.wonder1.de")],
      leases: [],
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("projects.conflict")
  })

  test("rejects lease collisions in both directions", () => {
    const sameHostname = devHostnameClaimValidate({
      user: "tim",
      project: "akademie",
      projects: [],
      leases: [lease("mitarbeiter", "akademie-x", "tim-akademie.wonder1.de")],
    })
    expect(sameHostname.success).toBe(false)
    if (!sameHostname.success) expect(sameHostname.code).toBe("projects.conflict")

    const sameProject = devHostnameClaimValidate({
      user: "tim",
      project: "akademie",
      projects: [],
      leases: [{ ...lease("tim", "akademie", "tim-akademie.wonder1.de"), hostname: "stale-akademie.wonder1.de" }],
    })
    expect(sameProject.success).toBe(false)
    if (!sameProject.success) expect(sameProject.code).toBe("projects.conflict")
  })

  test("accepts an idempotent claim for the same project and hostname", () => {
    const result = devHostnameClaimValidate({
      user: "tim",
      project: "akademie",
      projects: [],
      leases: [lease("tim", "akademie", "tim-akademie.wonder1.de")],
    })

    expect(result).toEqual({ success: true, data: "tim-akademie.wonder1.de" })
  })

  test("rejects invalid users and project names", () => {
    for (const options of [
      { user: "", project: "akademie" },
      { user: "tim!", project: "akademie" },
      { user: "tim", project: "Akademie" },
    ]) {
      const result = devHostnameClaimValidate({ ...options, projects: [], leases: [] })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.code).toBe("request.invalid")
    }
  })
})
