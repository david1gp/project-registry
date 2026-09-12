import * as a from "valibot"
import { projectSchema } from "./projectSchema.js"

export const projectLegacyPersistedSchema = a.strictObject({
  ...projectSchema.entries,
  type: a.optional(a.picklist(["own", "internal", "customer"])),
})

export type ProjectLegacyPersisted = a.InferOutput<typeof projectLegacyPersistedSchema>
