import { describe, expect, test } from "bun:test"
import { projectPrivateUpstreamValidate } from "./projectPrivateUpstreamValidate.js"

describe("projectPrivateUpstreamValidate", () => {
  test("passes public, disabled, and malformed routes untouched", () => {
    expect(projectPrivateUpstreamValidate(undefined).success).toBe(true)
    expect(projectPrivateUpstreamValidate(null).success).toBe(true)
    expect(projectPrivateUpstreamValidate("caddy").success).toBe(true)
    expect(projectPrivateUpstreamValidate({ upstream: "192.168.1.10" }).success).toBe(true)
    expect(projectPrivateUpstreamValidate({ networkVisibility: "public", upstream: "192.168.1.10" }).success).toBe(true)
    expect(
      projectPrivateUpstreamValidate({ networkVisibility: "private", disabled: true, upstream: "192.168.1.10" })
        .success,
    ).toBe(true)
  })

  test("passes private routes without an explicit upstream and bare ports", () => {
    expect(projectPrivateUpstreamValidate({ networkVisibility: "private", port: 3000 }).success).toBe(true)
    expect(projectPrivateUpstreamValidate({ networkVisibility: "private", upstream: null }).success).toBe(true)
    expect(projectPrivateUpstreamValidate({ networkVisibility: "private", upstream: 3000 }).success).toBe(true)
    expect(projectPrivateUpstreamValidate({ networkVisibility: "private", upstream: "3000" }).success).toBe(true)
    expect(projectPrivateUpstreamValidate({ networkVisibility: "private", upstream: "  " }).success).toBe(true)
  })

  test("passes loopback upstreams with or without a port", () => {
    for (const upstream of [
      "127.0.0.1",
      "127.0.0.1:3000",
      "127.1.2.3",
      "::1",
      "[::1]",
      "[::1]:3000",
      "localhost",
      "LOCALHOST",
      "localhost:3000",
      "  localhost  ",
    ]) {
      expect(projectPrivateUpstreamValidate({ networkVisibility: "private", upstream }).success).toBe(true)
    }
  })

  test("fails non-loopback upstreams with the tailnet-wide exposure reason and fix", () => {
    const result = projectPrivateUpstreamValidate(
      { networkVisibility: "private", upstream: "192.168.1.10:3000" },
      "worker",
    )
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("worker")
    expect(result.errorMessage).toContain("192.168.1.10:3000")
    expect(result.errorMessage).toContain("tailnet-wide")
    expect(result.errorMessage).toContain("Fix:")
  })

  test("fails LAN, wildcard-bind, and remote upstreams", () => {
    for (const upstream of ["10.0.0.5", "0.0.0.0", "0.0.0.0:3000", "example.com", "nas.lan", "2001:db8::1"]) {
      const result = projectPrivateUpstreamValidate({ networkVisibility: "private", upstream })
      expect(result.success).toBe(false)
    }
  })

  test("leaves non-string upstream values to schema validation", () => {
    expect(projectPrivateUpstreamValidate({ networkVisibility: "private", upstream: true }).success).toBe(true)
    expect(projectPrivateUpstreamValidate({ networkVisibility: "private", upstream: {} }).success).toBe(true)
  })
})
