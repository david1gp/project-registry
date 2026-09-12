import * as a from "valibot"
import { projectCaddySchema } from "./projectCaddySchema.js"
import { projectLabelsSchema } from "./projectLabelsSchema.js"

const serviceUnitSchema = a.pipe(a.string(), a.regex(/^[A-Za-z0-9_.@:-]+(?:\.service)?$/))
const nonEmptyTextSchema = a.pipe(a.string(), a.regex(/\S/))
const finiteNumberSchema = a.pipe(a.number(), a.finite())
const projectServicesSchema = a.pipe(
  a.array(serviceUnitSchema),
  a.check((services) => new Set(services).size === services.length, "services must be deduplicated"),
)

export const projectSchema = a.strictObject({
  schemaVersion: a.literal(1),
  owner: nonEmptyTextSchema,
  name: a.pipe(a.string(), a.regex(/^[a-z0-9][a-z0-9-]*$/)),
  description: a.optional(a.string()),
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
