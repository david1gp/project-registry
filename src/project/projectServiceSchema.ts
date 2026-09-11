import * as a from "valibot"
import { projectCaddySchema } from "./projectCaddySchema.js"
import { projectServiceOwnershipSchema } from "./projectServiceOwnershipSchema.js"

const serviceUnitSchema = a.pipe(a.string(), a.regex(/^[A-Za-z0-9_.@:-]+(?:\.service)?$/))
const projectServiceUnitsSchema = a.pipe(
  a.array(serviceUnitSchema),
  a.check((units) => new Set(units).size === units.length, "service units must be deduplicated"),
)
const projectServiceIdSchema = a.pipe(a.string(), a.regex(/^[a-z0-9][a-z0-9-]*$/))

export const projectServiceSchema = a.strictObject({
  id: projectServiceIdSchema,
  units: a.optional(projectServiceUnitsSchema, []),
  caddy: a.optional(a.nullable(projectCaddySchema), null),
  ownership: a.optional(projectServiceOwnershipSchema, "registry"),
})

export type ProjectService = a.InferOutput<typeof projectServiceSchema>
