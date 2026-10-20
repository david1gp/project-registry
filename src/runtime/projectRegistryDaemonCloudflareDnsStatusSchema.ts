import * as a from "valibot"

const timestampSchema = a.pipe(a.number(), a.integer(), a.minValue(0), a.maxValue(8_640_000_000_000_000))

const statusErrorSchema = a.looseObject({
  owner: a.optional(a.string()),
  project: a.optional(a.string()),
  hostname: a.optional(a.string()),
  recordId: a.optional(a.string()),
  operation: a.string(),
  errorMessage: a.string(),
  attempts: a.pipe(a.number(), a.integer(), a.minValue(0)),
  occurredAt: timestampSchema,
  nextRetryAt: a.optional(timestampSchema),
  statusCode: a.optional(a.pipe(a.number(), a.integer(), a.minValue(100), a.maxValue(599))),
  cloudflareCode: a.optional(a.pipe(a.number(), a.integer(), a.minValue(1), a.maxValue(Number.MAX_SAFE_INTEGER))),
})

export const projectRegistryDaemonCloudflareDnsStatusSchema = a.looseObject({
  enabled: a.boolean(),
  pendingProjects: a.pipe(a.number(), a.integer(), a.minValue(0)),
  pendingDeletions: a.pipe(a.number(), a.integer(), a.minValue(0)),
  trackingBlocked: a.boolean(),
  lastSuccess: a.optional(timestampSchema),
  errors: a.array(statusErrorSchema),
})

export type ProjectRegistryDaemonCloudflareDnsStatus = a.InferOutput<
  typeof projectRegistryDaemonCloudflareDnsStatusSchema
>
