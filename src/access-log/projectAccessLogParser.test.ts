import { describe, expect, test } from "bun:test"
import { caddyAccessLogFixture } from "../../test/fixtures/caddyAccessLogFixture.js"
import { projectAccessLogParser } from "./projectAccessLogParser.js"

describe("projectAccessLogParser", () => {
  test("parses and preserves a complete Caddy JSON access-log record", () => {
    const result = projectAccessLogParser(JSON.stringify(caddyAccessLogFixture))

    expect(result).toEqual({ success: true, data: caddyAccessLogFixture })
  })

  test("preserves nested fields, query strings, and credentials", () => {
    const result = projectAccessLogParser({
      ts: 1_700_000_000,
      request: {
        method: "GET",
        host: "app.example",
        uri: "/private?token=secret",
        client_ip: "192.0.2.123",
        headers: { authorization: ["Bearer secret"] },
      },
      status: 200,
      duration: 0.125,
      size: 42,
      resp_headers: { "set-cookie": ["secret"] },
    })

    expect(result).toEqual({
      success: true,
      data: {
        ts: 1_700_000_000,
        request: {
          method: "GET",
          host: "app.example",
          uri: "/private?token=secret",
          client_ip: "192.0.2.123",
          headers: { authorization: ["Bearer secret"] },
        },
        status: 200,
        duration: 0.125,
        size: 42,
        resp_headers: { "set-cookie": ["secret"] },
      },
    })
  })

  test("preserves IPv6 clients and rejects non-record or malformed values", () => {
    const record = {
      ts: 1,
      request: { method: "POST", host: "app.example", uri: "/", remote_ip: "2001:db8:abcd:1234:5678::9" },
      status: 201,
      duration: 0,
      size: 0,
    }
    expect(projectAccessLogParser(JSON.stringify(record))).toEqual({ success: true, data: record })

    expect(projectAccessLogParser("not-json")).toMatchObject({ success: false, code: "access-log.invalid-input" })
    expect(projectAccessLogParser([])).toMatchObject({ success: false, code: "access-log.invalid-input" })
  })

  test("rejects records outside the JSON bounds", () => {
    expect(projectAccessLogParser({ value: "x".repeat(1024 * 1024 + 1) })).toMatchObject({
      success: false,
      code: "access-log.invalid-input",
    })

    let nested: unknown = "value"
    for (let index = 0; index < 33; index += 1) nested = { nested }
    expect(projectAccessLogParser(nested)).toMatchObject({ success: false, code: "access-log.invalid-input" })
  })
})
