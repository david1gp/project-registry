import * as v from "valibot"

const projectAccessLogRecordSchema = v.object({
  timestamp: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(253_402_300_799)),
  method: v.string(),
  host: v.string(),
  path: v.string(),
  status: v.pipe(v.number(), v.finite(), v.safeInteger(), v.minValue(0), v.maxValue(999)),
  duration: v.pipe(v.number(), v.finite(), v.minValue(0)),
  responseBytes: v.pipe(v.number(), v.finite(), v.safeInteger(), v.minValue(0)),
  clientNetwork: v.string(),
})

export const projectAccessLogPageSchema = v.object({
  records: v.array(projectAccessLogRecordSchema),
  next: v.optional(v.string()),
  partial: v.boolean(),
  malformedLines: v.pipe(v.number(), v.finite(), v.safeInteger(), v.minValue(0)),
})

export type ProjectAccessLogPage = v.InferOutput<typeof projectAccessLogPageSchema>
