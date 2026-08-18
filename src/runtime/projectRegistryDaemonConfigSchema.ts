import * as a from "valibot"
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
  socketDirectory: a.optional(absolutePathSchema, "/run/project-registry"),
  webListener: a.optional(a.strictObject({ hostname: loopbackHostnameSchema, port: portSchema }), {
    hostname: "127.0.0.1",
    port: 8080,
  }),
  caddyBinary: a.optional(a.pipe(a.string(), a.minLength(1)), "caddy"),
  caddyAdminUrl: a.optional(a.pipe(a.string(), a.minLength(1)), "http://localhost:2019"),
  httpsListener: a.optional(httpsListenerSchema, ":443"),
  oidc: a.optional(caddyConfigOptionsSchema.entries.oidc),
  portRange: a.optional(portRangeSchema, { from: 3000, to: 3999 }),
  gitPush: a.optional(a.boolean(), false),
  regenerationIntervalMs: a.optional(durationSchema, 60_000),
  userRefreshIntervalMs: a.optional(durationSchema, 30_000),
  validationTimeoutMs: a.optional(durationSchema, 30_000),
  loadTimeoutMs: a.optional(durationSchema, 30_000),
  shutdownTimeoutMs: a.optional(durationSchema, 10_000),
})
