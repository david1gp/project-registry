import { describe, expect, test } from "bun:test"
import { caddyAccessLogFixture } from "../../test/fixtures/caddyAccessLogFixture.js"
import { projectAccessLogParser } from "./projectAccessLogParser.js"

describe("projectAccessLogParser", () => {
  test("parses a complete filtered Caddy JSON access-log record", () => {
    const result = projectAccessLogParser(JSON.stringify(caddyAccessLogFixture))

    expect(result).toEqual({
      success: true,
      data: {
        timestamp: 1_755_757_341.418,
        method: "GET",
        host: "app.example",
        path: "/private/report",
        status: 200,
        duration: 0.012345,
        responseBytes: 4096,
        clientNetwork: "198.51.100.0/24",
      },
    })
    expect(caddyAccessLogFixture.request).not.toHaveProperty("client_ip")
    expect(caddyAccessLogFixture.request).not.toHaveProperty("headers")
    expect(caddyAccessLogFixture).not.toHaveProperty("resp_headers")
  })

  test("returns only masked public fields and removes the query string", () => {
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
        timestamp: 1_700_000_000,
        method: "GET",
        host: "app.example",
        path: "/private",
        status: 200,
        duration: 0.125,
        responseBytes: 42,
        clientNetwork: "192.0.2.0/24",
      },
    })
  })

  test("masks IPv6 clients and rejects malformed records", () => {
    const result = projectAccessLogParser(
      JSON.stringify({
        ts: 1,
        request: { method: "POST", host: "app.example", uri: "/", remote_ip: "2001:db8:abcd:1234:5678::9" },
        status: 201,
        duration: 0,
        size: 0,
      }),
    )
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.clientNetwork).toBe("2001:db8:abcd:1234::/64")

    const malformed = projectAccessLogParser({ ts: 1, request: { method: "GET" } })
    expect(malformed).toMatchObject({ success: false, code: "access-log.invalid-input" })
  })
})
