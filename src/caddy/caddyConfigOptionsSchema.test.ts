import { expect, test } from "bun:test"
import * as a from "valibot"
import { caddyConfigOptionsSchema, oidcOptionsSchema } from "./caddyConfigOptionsSchema.js"

const base = {
  providerName: "zitadel",
  issuer: "https://auth.example",
  clientId: "client-id",
  clientSecret: "client-secret",
  cookieSecret: "0".repeat(32),
}

test("oidcOptionsSchema applies the legacy Caddy OIDC defaults", () => {
  const result = a.safeParse(oidcOptionsSchema, base)

  expect(result.success).toBe(true)
  if (!result.success) return
  expect(result.output).toEqual({
    ...base,
    scope: ["openid", "email", "profile"],
    username: "email",
    cookieName: "caddy",
    cookieMaxAge: "168h",
    redirectUrl: "/oauth2/callback",
  })
})

test("oidcOptionsSchema accepts only 32 or 64 character cookie secrets", () => {
  for (const length of [32, 64]) {
    expect(a.safeParse(oidcOptionsSchema, { ...base, cookieSecret: "0".repeat(length) }).success).toBe(true)
  }

  for (const length of [1, 16, 31, 33, 63, 65]) {
    expect(a.safeParse(oidcOptionsSchema, { ...base, cookieSecret: "0".repeat(length) }).success).toBe(false)
  }
})

test("caddyConfigOptionsSchema rejects incomplete or unknown OIDC configuration", () => {
  expect(a.safeParse(caddyConfigOptionsSchema, { oidc: { ...base, clientId: "" } }).success).toBe(false)
  expect(a.safeParse(caddyConfigOptionsSchema, { oidc: { ...base, unexpected: true } }).success).toBe(false)
  expect(a.safeParse(caddyConfigOptionsSchema, { unexpected: true }).success).toBe(false)
})

test("caddyConfigOptionsSchema allows OIDC to be missing", () => {
  const result = a.safeParse(caddyConfigOptionsSchema, {})

  expect(result.success).toBe(true)
  if (!result.success) return
  expect(result.output).toEqual({ httpsListener: ":443", networkVisibility: "public" })
})

test("caddyConfigOptionsSchema keeps legacy httpsListener on the :port form", () => {
  expect(a.safeParse(caddyConfigOptionsSchema, { httpsListener: ":8443" }).success).toBe(true)
  expect(a.safeParse(caddyConfigOptionsSchema, { httpsListener: "127.0.0.1:8443" }).success).toBe(false)
  expect(a.safeParse(caddyConfigOptionsSchema, { httpsListener: "[::1]:8443" }).success).toBe(false)
  expect(a.safeParse(caddyConfigOptionsSchema, { httpsListener: ":0" }).success).toBe(false)
})

test("caddyConfigOptionsSchema accepts explicit IPv4 and bracketed IPv6 httpsListeners", () => {
  const result = a.safeParse(caddyConfigOptionsSchema, {
    httpsListeners: [":443", "203.0.113.10:443", "100.122.200.114:443", "[::1]:443"],
  })

  expect(result.success).toBe(true)
  if (!result.success) return
  expect(result.output.httpsListeners).toEqual([":443", "203.0.113.10:443", "100.122.200.114:443", "[::1]:443"])
})

test("caddyConfigOptionsSchema rejects malformed httpsListeners", () => {
  const invalid = [
    [],
    ["8443"],
    [""],
    [":0"],
    [":65536"],
    [":abc"],
    [":443 "],
    ["999.999.999.999:443"],
    ["example.com:443"],
    ["*:443"],
    ["127.0.0.1"],
    ["127.0.0.1:0"],
    ["127.0.0.1:65536"],
    ["::1:443"],
    ["[::1]"],
    ["[::1]:0"],
    ["[::1]:65536"],
    ["[not-an-ip]:443"],
  ]

  for (const httpsListeners of invalid) {
    expect(a.safeParse(caddyConfigOptionsSchema, { httpsListeners }).success).toBe(false)
  }
})
