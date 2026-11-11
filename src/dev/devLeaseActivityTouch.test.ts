import { describe, expect, test } from "bun:test"
import { devLeaseActivityTouch } from "./devLeaseActivityTouch.js"
import type { DevLeaseRecord } from "./devLeaseRecordSchema.js"

function leaseCreate(overrides: Partial<DevLeaseRecord> & { name: string }): DevLeaseRecord {
  const { name, ...rest } = overrides
  return {
    projectKey: { owner: "tim", name },
    user: "tim",
    port: 4400,
    unit: `dev-tim-${name}.service`,
    hostname: `tim-${name}.wonder1.de`,
    state: "active",
    ttlMs: 14_400_000,
    lastSeenAt: 5_000,
    createdAt: 0,
    ...rest,
  }
}

describe("devLeaseActivityTouch", () => {
  test("advances an active lease to a newer observed timestamp", () => {
    const result = devLeaseActivityTouch({
      leases: [leaseCreate({ name: "akademie" })],
      observations: [{ host: "tim-akademie.wonder1.de", seenAt: 6_000 }],
      now: 6_000,
    })

    expect(result).toEqual({
      leases: [leaseCreate({ name: "akademie", lastSeenAt: 6_000 })],
      touched: 1,
    })
  })

  test("ignores observations for unknown hostnames and stale timestamps", () => {
    const before = [leaseCreate({ name: "akademie" })]
    const result = devLeaseActivityTouch({
      leases: before,
      observations: [
        { host: "tim-werkstatt.wonder1.de", seenAt: 9_000 },
        { host: "tim-akademie.wonder1.de", seenAt: 5_000 },
        { host: "tim-akademie.wonder1.de", seenAt: 4_000 },
      ],
      now: 9_000,
    })

    expect(result.touched).toBe(0)
    expect(result.leases).toEqual(before)
  })

  test("keeps the newest observation per host and clamps future timestamps to now", () => {
    const result = devLeaseActivityTouch({
      leases: [leaseCreate({ name: "akademie" })],
      observations: [
        { host: "tim-akademie.wonder1.de", seenAt: 6_000 },
        { host: "tim-akademie.wonder1.de", seenAt: 60_000 },
      ],
      now: 7_000,
    })

    expect(result.leases[0]?.lastSeenAt).toBe(7_000)
    expect(result.touched).toBe(1)
  })

  test("never touches starting leases, which have no route and no traffic", () => {
    const before = [leaseCreate({ name: "akademie", state: "starting" })]
    const result = devLeaseActivityTouch({
      leases: before,
      observations: [{ host: "tim-akademie.wonder1.de", seenAt: 9_000 }],
      now: 9_000,
    })

    expect(result.touched).toBe(0)
    expect(result.leases).toEqual(before)
  })

  test("skips malformed observations without touching anything", () => {
    const before = [leaseCreate({ name: "akademie" })]
    const result = devLeaseActivityTouch({
      leases: before,
      observations: [
        { host: "", seenAt: 9_000 },
        { host: "tim-akademie.wonder1.de", seenAt: Number.NaN },
        { host: "tim-akademie.wonder1.de", seenAt: -1 },
      ],
      now: 9_000,
    })

    expect(result.touched).toBe(0)
    expect(result.leases).toEqual(before)
  })

  test("an empty observation set leaves every lease untouched", () => {
    const before = [leaseCreate({ name: "akademie" })]
    const result = devLeaseActivityTouch({ leases: before, observations: [], now: 9_000 })

    expect(result.touched).toBe(0)
    expect(result.leases).toEqual(before)
  })
})
