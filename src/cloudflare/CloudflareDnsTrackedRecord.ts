import * as a from "valibot"

const nonBlankTextSchema = a.pipe(a.string(), a.regex(/\S/))

const projectKeySchema = a.strictObject({
  owner: nonBlankTextSchema,
  name: nonBlankTextSchema,
})

export const cloudflareDnsTrackedRecordSchema = a.strictObject({
  zoneId: nonBlankTextSchema,
  zoneName: nonBlankTextSchema,
  id: nonBlankTextSchema,
  name: nonBlankTextSchema,
  type: nonBlankTextSchema,
  content: nonBlankTextSchema,
  ttl: a.pipe(a.number(), a.integer(), a.minValue(1)),
  proxied: a.boolean(),
  projectKeys: a.array(projectKeySchema),
})

export type CloudflareDnsTrackedRecord = a.InferOutput<typeof cloudflareDnsTrackedRecordSchema>
