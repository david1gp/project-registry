import * as a from "valibot"
import { projectLabelsSchema } from "./projectLabelsSchema.js"
import { projectServiceSchema } from "./projectServiceSchema.js"

const nonEmptyTextSchema = a.pipe(a.string(), a.regex(/\S/))
const finiteNumberSchema = a.pipe(a.number(), a.finite())
const projectServicesSchema = a.pipe(
  a.array(projectServiceSchema),
  a.check(
    (services) => new Set(services.map((service) => service.id)).size === services.length,
    "service IDs must be unique",
  ),
)

export const projectCanonicalSchema = a.strictObject({
  schemaVersion: a.literal(2),
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
})

export type ProjectCanonical = a.InferOutput<typeof projectCanonicalSchema>
