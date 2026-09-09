import * as a from "valibot"
import { cloudflareDnsTrackedRecordSchema } from "../cloudflare/CloudflareDnsTrackedRecord.js"

const trackingStateSchema = a.strictObject({
  version: a.literal(1),
  records: a.array(cloudflareDnsTrackedRecordSchema),
})

export type ProjectRegistryDaemonCloudflareDnsTrackingState = a.InferOutput<typeof trackingStateSchema>

export { trackingStateSchema as projectRegistryDaemonCloudflareDnsTrackingStateSchema }
