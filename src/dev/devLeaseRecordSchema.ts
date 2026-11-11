import * as a from "valibot"

const nonBlankTextSchema = a.pipe(a.string(), a.regex(/\S/))

const devLeaseStateSchema = a.picklist(["starting", "active", "stopping"])

export const devLeaseRecordSchema = a.strictObject({
  projectKey: a.strictObject({
    owner: nonBlankTextSchema,
    name: nonBlankTextSchema,
  }),
  serviceId: a.optional(a.pipe(a.string(), a.regex(/^[a-z0-9][a-z0-9-]*$/))),
  user: nonBlankTextSchema,
  port: a.pipe(a.number(), a.integer(), a.minValue(1), a.maxValue(65535)),
  unit: nonBlankTextSchema,
  hostname: nonBlankTextSchema,
  state: devLeaseStateSchema,
  ttlMs: a.pipe(a.number(), a.integer(), a.minValue(1)),
  lastSeenAt: a.pipe(a.number(), a.integer(), a.minValue(0)),
  createdAt: a.pipe(a.number(), a.integer(), a.minValue(0)),
})

export type DevLeaseRecord = a.InferOutput<typeof devLeaseRecordSchema>
