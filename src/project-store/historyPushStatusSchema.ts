import * as a from "valibot"

export const historyPushStatusSchema = a.object({
  enabled: a.boolean(),
  pending: a.boolean(),
  inFlight: a.boolean(),
  lastAttemptAt: a.nullable(a.number()),
  lastSuccessAt: a.nullable(a.number()),
  lastPushedRevision: a.nullable(a.string()),
  lastError: a.nullable(a.object({ message: a.string(), at: a.number() })),
  consecutiveFailures: a.number(),
  aheadCount: a.nullable(a.number()),
})

export type HistoryPushStatus = a.InferOutput<typeof historyPushStatusSchema>
