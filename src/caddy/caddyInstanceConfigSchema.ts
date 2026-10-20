import * as a from "valibot"
import { projectAccessLogRootSchema } from "../access-log/projectAccessLogRootSchema.js"

// Shape-only schema for the optional dual-target Caddy map. Semantic rules
// (explicit binds, no overlap, distinct admins/roots) are enforced by
// caddyInstanceTargetsValidate; this file only pins the accepted JSON shape.
// Strict objects reject unknown keys, so per-instance OIDC, Zitadel, and
// service-token fields are refused here. Shared OIDC stays daemon-level and
// is inherited by both targets at resolution time.
const absolutePathSchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.check((value) => value.startsWith("/"), "path must be absolute"),
  a.check((value) => !value.includes("\0"), "path must not contain NUL bytes"),
)

const instanceAdminUrlSchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.check((value) => {
    try {
      const url = new URL(value)
      const hostname =
        url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname
      return (
        ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "::1"].includes(hostname) &&
        url.username === "" &&
        url.password === ""
      )
    } catch {
      return false
    }
  }, "Caddy admin URL must be an HTTP(S) loopback URL without credentials"),
)

const instanceListenersSchema = a.pipe(
  a.array(a.pipe(a.string(), a.minLength(1))),
  a.minLength(1, "HTTPS listeners must not be empty"),
  a.check((listeners) => new Set(listeners).size === listeners.length, "HTTPS listeners must be unique"),
)

const serviceIdentitySchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.maxLength(256),
  a.check((value) => value !== "0", "Caddy service identity must not be numeric root"),
  a.regex(/^(?:[0-9]+|[A-Za-z_][A-Za-z0-9_.@-]*\$?)$/, "Caddy service identity is invalid"),
)

const publicInstanceSchema = a.strictObject({
  adminUrl: a.optional(instanceAdminUrlSchema),
  httpsListeners: a.optional(instanceListenersSchema),
  baseConfigPath: a.optional(absolutePathSchema),
  caddyUser: a.optional(serviceIdentitySchema),
  caddyGroup: a.optional(serviceIdentitySchema),
  accessLogRoot: a.optional(projectAccessLogRootSchema),
})

const privateInstanceSchema = a.strictObject({
  adminUrl: instanceAdminUrlSchema,
  httpsListeners: instanceListenersSchema,
  baseConfigPath: absolutePathSchema,
  caddyUser: a.optional(serviceIdentitySchema),
  caddyGroup: a.optional(serviceIdentitySchema),
  accessLogRoot: a.optional(projectAccessLogRootSchema),
})

export const caddyInstanceConfigSchema = a.strictObject({
  public: a.optional(publicInstanceSchema),
  private: a.optional(privateInstanceSchema),
})

export type CaddyInstanceConfig = a.InferOutput<typeof caddyInstanceConfigSchema>
