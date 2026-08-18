import * as a from "valibot"

const httpsListenerSchema = a.pipe(
  a.string(),
  a.regex(/^:\d+$/, "HTTPS listener must use the :<port> form"),
  a.check((listener) => {
    const port = Number(listener.slice(1))
    return port >= 1 && port <= 65535
  }, "HTTPS listener port must be between 1 and 65535"),
)

export const oidcOptionsSchema = a.strictObject({
  providerName: a.pipe(a.string(), a.minLength(1)),
  issuer: a.pipe(a.string(), a.minLength(1)),
  clientId: a.pipe(a.string(), a.minLength(1)),
  clientSecret: a.pipe(a.string(), a.minLength(1)),
  scope: a.optional(a.array(a.string()), ["openid", "email", "profile"]),
  username: a.optional(a.string(), "email"),
  cookieName: a.optional(a.string(), "caddy"),
  cookieSecret: a.pipe(
    a.string(),
    a.check(
      (secret) => secret.length === 32 || secret.length === 64,
      "cookieSecret must be exactly 32 or 64 bytes long",
    ),
  ),
  cookieMaxAge: a.optional(a.string(), "168h"),
  redirectUrl: a.optional(a.string(), "/oauth2/callback"),
})

export type OidcOptions = {
  providerName: string
  issuer: string
  clientId: string
  clientSecret: string
  scope?: string[]
  username?: string
  cookieName?: string
  cookieSecret: string
  cookieMaxAge?: string
  redirectUrl?: string
}

export const caddyConfigOptionsSchema = a.strictObject({
  httpsListener: a.optional(httpsListenerSchema, ":443"),
  oidc: a.optional(oidcOptionsSchema),
})

export type CaddyConfigOptions = {
  httpsListener?: string
  oidc?: OidcOptions
}
