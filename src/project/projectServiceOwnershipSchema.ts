import * as a from "valibot"

export const projectServiceOwnershipSchema = a.picklist(["registry", "external"])

export type ProjectServiceOwnership = a.InferOutput<typeof projectServiceOwnershipSchema>
