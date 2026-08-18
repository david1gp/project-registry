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
  expect(result.output).toEqual({ httpsListener: ":443" })
})
