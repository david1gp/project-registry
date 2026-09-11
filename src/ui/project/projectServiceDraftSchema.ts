import * as v from "valibot"
import { projectServiceOwnershipSchema } from "../../project/projectServiceOwnershipSchema.js"

/** Editable form state for one project service; persisted and validated before saving. */
export const projectServiceDraftSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, "Die Dienst-ID ist ungültig.")),
  ownership: v.optional(projectServiceOwnershipSchema),
  port: v.pipe(v.string(), v.regex(/^\d+$/, "Der Port muss eine Zahl von 1 bis 65535 sein.")),
  domains: v.string(),
  path: v.string(),
  kind: v.picklist(["proxy", "static"]),
  access: v.picklist(["internal", "external"]),
  disabled: v.boolean(),
  docs: v.boolean(),
  browse: v.boolean(),
  spa: v.boolean(),
})

export type ProjectServiceDraft = v.InferOutput<typeof projectServiceDraftSchema>
