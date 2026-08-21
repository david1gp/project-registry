import { describe, expect, test } from "bun:test"
import * as v from "valibot"
import { projectAccessLogPageSchema } from "./projectAccessLogPageSchema.js"

const pageWithTimestamp = (timestamp: number) => ({
  records: [
    {
      timestamp,
      method: "GET",
      host: "app.example",
      path: "/",
      status: 200,
      duration: 0.01,
      responseBytes: 42,
      clientNetwork: "192.0.2.0/24",
    },
  ],
  partial: false,
  malformedLines: 0,
})

const pageWithRecordNumber = (field: "status" | "duration" | "responseBytes", value: number) => {
  const page = pageWithTimestamp(1_755_757_341.418)
  page.records[0]![field] = value
  return page
}

describe("projectAccessLogPageSchema", () => {
  test("accepts realistic fractional Caddy epoch seconds", () => {
    expect(v.safeParse(projectAccessLogPageSchema, pageWithTimestamp(1_755_757_341.418)).success).toBe(true)
  })

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1_755_757_341_418])(
    "rejects an unrealistic timestamp: %p",
    (timestamp) => {
      expect(v.safeParse(projectAccessLogPageSchema, pageWithTimestamp(timestamp)).success).toBe(false)
    },
  )

  test.each([
    ["status", -1],
    ["status", 1.5],
    ["status", 1_000],
    ["status", Number.NaN],
    ["duration", -0.1],
    ["duration", Number.POSITIVE_INFINITY],
    ["responseBytes", -1],
    ["responseBytes", 1.5],
    ["responseBytes", Number.POSITIVE_INFINITY],
  ] as const)("rejects invalid %s values: %p", (field, value) => {
    expect(v.safeParse(projectAccessLogPageSchema, pageWithRecordNumber(field, value)).success).toBe(false)
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid malformed line counts: %p", (value) => {
    expect(
      v.safeParse(projectAccessLogPageSchema, { ...pageWithTimestamp(1_755_757_341.418), malformedLines: value })
        .success,
    ).toBe(false)
  })
})
