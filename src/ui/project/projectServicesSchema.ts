import * as v from "valibot"

const projectServiceCaddySchema = v.object({
  port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
  domains: v.array(v.string()),
  path: v.optional(v.string(), ""),
  access: v.optional(v.picklist(["internal", "external"]), "external"),
  kind: v.optional(v.picklist(["proxy", "static"]), "proxy"),
  docs: v.optional(v.boolean(), true),
  browse: v.optional(v.boolean(), false),
  disabled: v.optional(v.boolean(), false),
  spa: v.optional(v.boolean(), false),
  denyDotfiles: v.optional(v.boolean(), false),
  headerUp: v.optional(v.record(v.string(), v.string()), {}),
  routed: v.optional(v.string()),
  docsPath: v.optional(v.string()),
  flushInterval: v.optional(v.number()),
})

const projectServiceSchema = v.object({
  id: v.string(),
  units: v.optional(v.array(v.string()), []),
  caddy: v.optional(v.nullable(projectServiceCaddySchema), null),
})

/** Canonical version 2 project shape as consumed by the project services UI. */
export const projectServicesSchema = v.object({
  schemaVersion: v.literal(2),
  owner: v.string(),
  name: v.string(),
  labels: v.optional(v.record(v.string(), v.string()), {}),
  services: v.optional(v.array(projectServiceSchema), []),
})

export type ProjectServices = v.InferOutput<typeof projectServicesSchema>
export type ProjectServicesService = ProjectServices["services"][number]
