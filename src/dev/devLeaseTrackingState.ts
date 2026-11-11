import * as a from "valibot"
import { devLeaseRecordSchema } from "./devLeaseRecordSchema.js"

const devLeaseTrackingStateSchema = a.strictObject({
  version: a.literal(1),
  leases: a.array(devLeaseRecordSchema),
})

export type DevLeaseTrackingState = a.InferOutput<typeof devLeaseTrackingStateSchema>

export { devLeaseTrackingStateSchema }
