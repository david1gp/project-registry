import * as a from "valibot"

export const managedServiceActionSchema = a.picklist(["start", "stop", "restart", "enable", "disable"])

export type ManagedServiceAction = a.InferOutput<typeof managedServiceActionSchema>
