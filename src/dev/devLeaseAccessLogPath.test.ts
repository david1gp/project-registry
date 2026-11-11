import { describe, expect, test } from "bun:test"
import { devLeaseAccessLogPath } from "./devLeaseAccessLogPath.js"

describe("devLeaseAccessLogPath", () => {
  test("resolves the shared dev log as a dev-leases sibling of the project logs", () => {
    const result = devLeaseAccessLogPath("/var/lib/project-registry/caddy-access-logs")

    expect(result).toEqual({
      success: true,
      data: "/var/lib/project-registry/caddy-access-logs/dev-leases/access.jsonl",
    })
  })

  test("rejects an invalid access-log root instead of deriving a log path", () => {
    const result = devLeaseAccessLogPath("")

    expect(result.success).toBe(false)
  })
})
