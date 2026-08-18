import { expect, test } from "bun:test"
import { caddyConfigOptionsFromEnv } from "./caddyConfigOptionsFromEnv.js"

const base = {
  PROJECT_REGISTRY_OIDC_ISSUER: "https://auth.example",
  PROJECT_REGISTRY_OIDC_CLIENT_ID: "client-id",
  PROJECT_REGISTRY_OIDC_CLIENT_SECRET: "client-secret",
  PROJECT_REGISTRY_OIDC_COOKIE_SECRET: "0".repeat(32),
}

test("caddyConfigOptionsFromEnv parses the registry OIDC environment", () => {
  const result = caddyConfigOptionsFromEnv(base)

  expect(result.success).toBe(true)
  if (!result.success) return
  expect(result.data.httpsListener).toBe(":443")
  expect(result.data.oidc).toEqual({
    providerName: "zitadel",
    issuer: "https://auth.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    cookieSecret: "0".repeat(32),
    scope: ["openid", "email", "profile"],
    username: "email",
    cookieName: "caddy",
    cookieMaxAge: "168h",
    redirectUrl: "/oauth2/callback",
  })
})

test("caddyConfigOptionsFromEnv keeps legacy environment names during migration", () => {
  const result = caddyConfigOptionsFromEnv({
    CADDY_PROJECTS_OIDC_ISSUER: "https://auth.example",
    CADDY_PROJECTS_OIDC_CLIENT_ID: "client-id",
    CADDY_PROJECTS_OIDC_CLIENT_SECRET: "client-secret",
    CADDY_PROJECTS_OIDC_COOKIE_SECRET: "0".repeat(64),
    CADDY_PROJECTS_OIDC_PROVIDER: "legacy",
  })

  expect(result.success).toBe(true)
  if (!result.success) return
  expect(result.data.oidc?.providerName).toBe("legacy")
  expect(result.data.oidc?.cookieSecret).toHaveLength(64)
})

test("caddyConfigOptionsFromEnv disables OIDC when the issuer is missing", () => {
  const result = caddyConfigOptionsFromEnv({ PROJECT_REGISTRY_OIDC_CLIENT_ID: "orphaned" })

  expect(result).toEqual({ success: true, data: { httpsListener: ":443" } })
})

test("caddyConfigOptionsFromEnv returns sanitized Results for malformed OIDC values", () => {
  for (const environment of [
    { ...base, PROJECT_REGISTRY_OIDC_COOKIE_SECRET: "short" },
    { ...base, PROJECT_REGISTRY_OIDC_CLIENT_ID: "" },
    null,
  ]) {
    let result: ReturnType<typeof caddyConfigOptionsFromEnv> | undefined
    expect(() => {
      result = caddyConfigOptionsFromEnv(environment)
    }).not.toThrow()
    expect(result?.success).toBe(false)
  }

  const environment = new Proxy(base, {
    get() {
      throw new Error("secret environment getter")
    },
  })
  const result = caddyConfigOptionsFromEnv(environment)

  expect(result.success).toBe(false)
  if (result.success) return
  expect(result.errorMessage).toBe("invalid environment configuration")
  expect(result.errorMessage).not.toContain("secret environment getter")
})
