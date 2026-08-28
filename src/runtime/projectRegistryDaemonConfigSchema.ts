import * as a from "valibot"
import { projectAccessLogRootSchema } from "../access-log/projectAccessLogRootSchema.js"
import { caddyConfigOptionsSchema } from "../caddy/caddyConfigOptionsSchema.js"

const loopbackHostnameSchema = a.union([a.literal("127.0.0.1"), a.literal("::1")])

const portSchema = a.pipe(
  a.number(),
  a.integer("port must be an integer"),
  a.minValue(1, "port must be between 1 and 65535"),
  a.maxValue(65535, "port must be between 1 and 65535"),
)

const durationSchema = a.pipe(
  a.number(),
  a.integer("duration must be an integer"),
  a.minValue(1, "duration must be positive"),
)

const usernameSchema = a.pipe(
  a.string(),
  a.maxLength(255, "mapped user name is too long"),
  a.regex(/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/, "mapped user name is invalid"),
)

const absolutePathSchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.check((value) => value.startsWith("/"), "path must be absolute"),
  a.check((value) => !value.includes("\0"), "path must not contain NUL bytes"),
)

const branchSchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.check(
    (value) =>
      !value.startsWith("-") &&
      [...value].every((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint !== undefined && codePoint > 0x20 && codePoint !== 0x7f
      }),
    "repository branch is invalid",
  ),
)

const httpsListenerSchema = a.pipe(
  a.string(),
  a.regex(/^:\d+$/, "HTTPS listener must use the :<port> form"),
  a.check((value) => {
    const port = Number(value.slice(1))
    return Number.isInteger(port) && port >= 1 && port <= 65535
  }, "HTTPS listener port must be between 1 and 65535"),
)

const portRangeSchema = a.strictObject({
  from: portSchema,
  to: portSchema,
})

const boundedIdentityValueSchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.maxLength(256),
  a.check((value) => value.trim() === value, "identity value must not be padded"),
  a.check(
    (value) => [...value].every((character) => character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f),
    "identity value is invalid",
  ),
)

const caddyServiceIdentitySchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.maxLength(256),
  a.check((value) => value !== "root" && value !== "0", "Caddy service identity must not be root"),
  a.regex(/^(?:[0-9]+|[A-Za-z_][A-Za-z0-9_.@-]*\$?)$/, "Caddy service identity is invalid"),
)

const identityIssuerSchema = a.pipe(
  a.string(),
  a.maxLength(2048),
  a.check((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === "https:" &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.hash.length === 0 &&
        url.search.length === 0 &&
        url.pathname === "/" &&
        url.origin === value
      )
    } catch {
      return false
    }
  }, "Zitadel issuer must be an exact HTTPS origin"),
)

const serviceTokenSchema = a.pipe(
  a.string(),
  a.minLength(1),
  a.maxLength(8192),
  a.check((value) => value.trim() === value, "service token must not be padded"),
  a.check(
    (value) => [...value].every((character) => character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f),
    "service token is invalid",
  ),
)

const sessionMaxAgeSchema = a.pipe(
  a.number(),
  a.integer("session lifetime must be an integer"),
  a.minValue(1, "session lifetime must be positive"),
  a.maxValue(31_536_000, "session lifetime is too long"),
)

const sessionMaxEntriesSchema = a.pipe(
  a.number(),
  a.integer("session capacity must be an integer"),
  a.minValue(1, "session capacity must be positive"),
  a.maxValue(100_000, "session capacity is too large"),
)

const zitadelSchema = a.strictObject({
  issuer: identityIssuerSchema,
  orgId: boundedIdentityValueSchema,
  projectId: boundedIdentityValueSchema,
  serviceToken: serviceTokenSchema,
})

const sessionSchema = a.strictObject({
  maxAgeSeconds: a.optional(sessionMaxAgeSchema),
  maxEntries: a.optional(sessionMaxEntriesSchema),
})

export const projectRegistryDaemonConfigSchema = a.strictObject({
  repositoryPath: absolutePathSchema,
  repositoryBranch: a.optional(branchSchema, "main"),
  mappedUsers: a.optional(
    a.pipe(
      a.array(usernameSchema),
      a.check((users) => new Set(users).size === users.length, "mapped users must be unique"),
    ),
    [],
  ),
  defaultUserDomains: a.optional(a.record(usernameSchema, a.pipe(a.string(), a.minLength(1))), {}),
  socketDirectory: a.optional(absolutePathSchema, "/run/project-registry"),
  webListener: a.optional(a.strictObject({ hostname: loopbackHostnameSchema, port: portSchema }), {
    hostname: "127.0.0.1",
    port: 8080,
  }),
  caddyBinary: a.optional(a.pipe(a.string(), a.minLength(1)), "caddy"),
  caddyAdminUrl: a.optional(a.pipe(a.string(), a.minLength(1)), "http://localhost:2019"),
  caddyUser: a.optional(caddyServiceIdentitySchema),
  caddyGroup: a.optional(caddyServiceIdentitySchema),
  caddyAccessLogRoot: a.optional(projectAccessLogRootSchema),
  httpsListener: a.optional(httpsListenerSchema, ":443"),
  oidc: a.optional(caddyConfigOptionsSchema.entries.oidc),
  zitadel: a.optional(zitadelSchema),
  session: a.optional(sessionSchema, {}),
  portRange: a.optional(portRangeSchema, { from: 3000, to: 3999 }),
  gitPush: a.optional(a.boolean(), false),
  regenerationIntervalMs: a.optional(durationSchema, 60_000),
  userRefreshIntervalMs: a.optional(durationSchema, 30_000),
  validationTimeoutMs: a.optional(durationSchema, 30_000),
  loadTimeoutMs: a.optional(durationSchema, 30_000),
  shutdownTimeoutMs: a.optional(durationSchema, 10_000),
  initializeFromGeneratedConfig: a.optional(a.boolean(), false),
})
