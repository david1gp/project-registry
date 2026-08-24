import * as a from "valibot"
import { projectHeaderUpSchema } from "./projectHeaderUpSchema.js"
import { projectLabelsSchema } from "./projectLabelsSchema.js"

const serviceUnitSchema = a.pipe(a.string(), a.regex(/^[A-Za-z0-9_.@:-]+(?:\.service)?$/))
const nonEmptyTextSchema = a.pipe(a.string(), a.regex(/\S/))
const finiteNumberSchema = a.pipe(a.number(), a.finite())
const legacyOidcPathSchema = a.pipe(a.string(), a.minLength(1))
const legacyStaticAllowPathSchema = a.pipe(a.string(), a.minLength(1))
const projectServicesSchema = a.pipe(
  a.array(serviceUnitSchema),
  a.check((services) => new Set(services).size === services.length, "services must be deduplicated"),
)

const projectCaddySchema = a.strictObject({
  port: a.pipe(a.number(), a.integer(), a.minValue(1), a.maxValue(65535)),
  domains: a.pipe(a.array(nonEmptyTextSchema), a.minLength(1)),
  path: a.optional(a.string(), ""),
  access: a.optional(a.picklist(["internal", "external"]), "external"),
  kind: a.optional(a.picklist(["proxy", "static"]), "proxy"),
  docs: a.optional(a.boolean(), true),
  browse: a.optional(a.boolean(), false),
  headerUp: a.optional(projectHeaderUpSchema, {}),
  disabled: a.optional(a.boolean(), false),
  routed: a.optional(a.string()),
  oidcPaths: a.optional(a.array(legacyOidcPathSchema)),
  docsPath: a.optional(a.string()),
  browseTemplate: a.optional(a.string()),
  staticAllow: a.optional(a.array(legacyStaticAllowPathSchema)),
  denyDotfiles: a.optional(a.boolean(), false),
  spa: a.optional(a.boolean(), false),
  flushInterval: a.optional(finiteNumberSchema),
})

export const projectSchema = a.strictObject({
  schemaVersion: a.literal(1),
  owner: nonEmptyTextSchema,
  name: a.pipe(a.string(), a.regex(/^[a-z0-9][a-z0-9-]*$/)),
  description: a.optional(a.string()),
  type: a.optional(a.picklist(["own", "internal", "customer"]), "customer"),
  order: a.optional(finiteNumberSchema, Number.MAX_SAFE_INTEGER),
  services: a.optional(projectServicesSchema, []),
  labels: a.optional(projectLabelsSchema, {}),
  github: a.optional(a.string()),
  previewUrl: a.optional(a.string()),
  previewPort: a.optional(a.string()),
  productionUrl: a.optional(a.string()),
  productionAssetsUrl: a.optional(a.string()),
  caddy: a.optional(a.nullable(projectCaddySchema)),
})

export type Project = a.InferOutput<typeof projectSchema>
