import { describe, expect, test } from "bun:test"
import * as v from "valibot"
import { projectAccessLogPageSchema } from "./projectAccessLogPageSchema.js"

const pageWithRecord = (record: unknown) => ({
  records: [record],
  partial: false,
  malformedLines: 0,
})

const rawRecord = {
  level: "info",
  ts: 1_755_757_341.418,
  request: {
    method: "GET",
    host: "app.example",
    uri: "/private/report?download=full",
    client_ip: "198.51.100.23",
    headers: { authorization: ["Bearer secret"], cookie: ["session=secret"] },
    tls: { resumed: false, server_name: null },
  },
  duration: 0.01,
  size: 42,
  status: 200,
  resp_headers: { "set-cookie": ["session=secret; Secure"] },
}

const page = (malformedLines: number) => ({
  records: [rawRecord],
  partial: false,
  malformedLines,
})

describe("projectAccessLogPageSchema", () => {
  test("preserves a complete raw Caddy JSON record", () => {
    const result = v.safeParse(projectAccessLogPageSchema, page(0))
    expect(result.success).toBe(true)
    if (result.success) expect(result.output.records[0]).toEqual(rawRecord)
  })

  test.each([[null], [[]], ["record"], [42]] as const)("rejects a non-object record: %p", (record) => {
    expect(v.safeParse(projectAccessLogPageSchema, pageWithRecord(record)).success).toBe(false)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, new Date()])("rejects a non-JSON value: %p", (value) => {
    expect(v.safeParse(projectAccessLogPageSchema, pageWithRecord({ value })).success).toBe(false)
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid malformed line counts: %p", (value) => {
    expect(v.safeParse(projectAccessLogPageSchema, page(value)).success).toBe(false)
  })
})
