import { isIP } from "node:net"
import * as a from "valibot"
import { projectAccessLogRootSchema } from "../access-log/projectAccessLogRootSchema.js"

const httpsListenerSchema = a.pipe(
  a.string(),
  a.regex(/^:\d+$/, "HTTPS listener must use the :<port> form"),
  a.check((listener) => {
    const port = Number(listener.slice(1))
    return port >= 1 && port <= 65535
  }, "HTTPS listener port must be between 1 and 65535"),
)

function httpsListenerPortTextValidate(portText: string): boolean {
  if (!/^\d+$/.test(portText)) return false
  const port = Number(portText)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function httpsListenersEntryValidate(listener: string): boolean {
  if (listener.startsWith(":")) return httpsListenerPortTextValidate(listener.slice(1))
  if (listener.startsWith("[")) {
    const separator = listener.indexOf("]:")
    if (separator <= 1) return false
    const ip = listener.slice(1, separator)
    const portText = listener.slice(separator + 2)
    if (portText.includes(":") || portText.includes("[") || portText.includes("]")) return false
    if (isIP(ip) !== 6) return false
    return httpsListenerPortTextValidate(portText)
  }
  const separator = listener.lastIndexOf(":")
  if (separator <= 0) return false
  const host = listener.slice(0, separator)
  const portText = listener.slice(separator + 1)
  if (host.includes(":") || host.includes("[") || host.includes("]") || host.includes(" ")) return false
  if (isIP(host) !== 4) return false
  return httpsListenerPortTextValidate(portText)
}

const httpsListenersEntrySchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.check(
    httpsListenersEntryValidate,
    "HTTPS listener must use :<port>, <IPv4>:<port>, or [<IPv6>]:<port> with port 1-65535",
  ),
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
  httpsListeners: a.optional(a.pipe(a.array(httpsListenersEntrySchema), a.minLength(1))),
  networkVisibility: a.optional(a.picklist(["public", "private"]), "public"),
  oidc: a.optional(oidcOptionsSchema),
  caddyAccessLogRoot: a.optional(projectAccessLogRootSchema),
})

export type CaddyConfigOptions = {
  httpsListener?: string
  httpsListeners?: string[]
  networkVisibility?: "public" | "private"
  oidc?: OidcOptions
  caddyAccessLogRoot?: string
}
