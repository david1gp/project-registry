import * as a from "valibot"

const timestampSchema = a.pipe(a.number(), a.integer(), a.minValue(0), a.maxValue(8_640_000_000_000_000))

const statusErrorSchema = a.looseObject({
  owner: a.optional(a.string()),
  hostname: a.optional(a.string()),
  operation: a.string(),
  errorMessage: a.string(),
  attempts: a.pipe(a.number(), a.integer(), a.minValue(0)),
  occurredAt: timestampSchema,
  nextRetryAt: a.optional(timestampSchema),
})

export const projectRegistryDaemonPrivateTlsStatusSchema = a.looseObject({
  enabled: a.boolean(),
  pendingOwners: a.pipe(a.number(), a.integer(), a.minValue(0)),
  enrolled: a.array(a.string()),
  wildcardCovered: a.array(a.string()),
  proven: a.array(a.string()),
  challengeResolvers: a.array(a.string()),
  lastSuccess: a.optional(timestampSchema),
  errors: a.array(statusErrorSchema),
})

export type ProjectRegistryDaemonPrivateTlsStatus = a.InferOutput<typeof projectRegistryDaemonPrivateTlsStatusSchema>
