import * as a from "valibot"

export const cloudflareDnsOperationSchema = a.union([
  a.literal("zone-lookup"),
  a.literal("record-list"),
  a.literal("record-create"),
  a.literal("record-update"),
  a.literal("record-verify"),
  a.literal("record-delete"),
  a.literal("request"),
])

export type CloudflareDnsOperation = a.InferOutput<typeof cloudflareDnsOperationSchema>
