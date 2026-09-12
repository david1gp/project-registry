import * as a from "valibot"
import { projectHeaderUpSchema } from "./projectHeaderUpSchema.js"

const nonEmptyTextSchema = a.pipe(a.string(), a.regex(/\S/))
const finiteNumberSchema = a.pipe(a.number(), a.finite())
const oidcPathSchema = a.pipe(a.string(), a.minLength(1))
const staticAllowPathSchema = a.pipe(a.string(), a.minLength(1))

export const projectCaddySchema = a.strictObject({
  port: a.pipe(a.number(), a.integer(), a.minValue(1), a.maxValue(65535)),
  domains: a.pipe(a.array(nonEmptyTextSchema), a.minLength(1)),
  path: a.optional(a.string(), ""),
  access: a.optional(a.picklist(["internal", "external"]), "external"),
  kind: a.optional(a.picklist(["proxy", "static"]), "proxy"),
  docs: a.optional(a.boolean(), false),
  browse: a.optional(a.boolean(), false),
  headerUp: a.optional(projectHeaderUpSchema, {}),
  disabled: a.optional(a.boolean(), false),
  routed: a.optional(a.string()),
  oidcPaths: a.optional(a.array(oidcPathSchema)),
  docsPath: a.optional(a.string()),
  browseTemplate: a.optional(a.string()),
  staticAllow: a.optional(a.array(staticAllowPathSchema)),
  denyDotfiles: a.optional(a.boolean(), false),
  spa: a.optional(a.boolean(), false),
  flushInterval: a.optional(finiteNumberSchema),
})

export type ProjectCaddy = a.InferOutput<typeof projectCaddySchema>
