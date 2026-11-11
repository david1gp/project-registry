import { describe, expect, test } from "bun:test"
import { projectNormalize } from "../project/projectNormalize.js"
import type { Project } from "../project/projectSchema.js"
import { devPortAllocate } from "./devPortAllocate.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"

function project(owner: string, name: string, port: number, disabled = false): Project {
  const result = projectNormalize({
    owner,
    name,
    caddy: { port, domains: [`${name}.example`], disabled },
  })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

function lease(name: string, port: number, owner = "tim"): DevLeaseRecord {
  return {
    projectKey: { owner, name },
    user: owner,
    port,
    unit: `dev-${owner}-${name}.service`,
    hostname: `${owner}-${name}.wonder1.de`,
    state: "active",
    ttlMs: 14_400_000,
    lastSeenAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
  }
}

describe("devPortAllocate", () => {
  test("skips row ports and active lease ports", () => {
    const result = devPortAllocate(
      [project("leo", "site", 3000), project("leo", "other", 3002)],
      [lease("akademie", 3001)],
      { from: 3000, to: 3005 },
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe(3003)
  })

  test("returns the lowest free port when leases hold the range start", () => {
    const result = devPortAllocate([], [lease("akademie", 3000), lease("werkstatt", 3001)], {
      from: 3000,
      to: 3002,
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe(3002)
  })

  test("reports exhaustion when rows and leases cover the range", () => {
    const result = devPortAllocate([project("leo", "site", 3000)], [lease("akademie", 3001)], {
      from: 3000,
      to: 3001,
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe("request.invalid")
    expect(result.errorMessage).toContain("no free port")
  })
})
