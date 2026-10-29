import * as a from "valibot"

const nonBlankTextSchema = a.pipe(a.string(), a.regex(/\S/))

const projectKeySchema = a.strictObject({
  owner: nonBlankTextSchema,
  name: nonBlankTextSchema,
})

export const projectRegistryDaemonPrivateDnsTrackedHostSchema = a.strictObject({
  hostname: nonBlankTextSchema,
  owner: nonBlankTextSchema,
  zone: nonBlankTextSchema,
  nodeAddress: a.pipe(a.string(), a.ipv4()),
  projectKeys: a.array(projectKeySchema),
})

export type ProjectRegistryDaemonPrivateDnsTrackedHost = a.InferOutput<
  typeof projectRegistryDaemonPrivateDnsTrackedHostSchema
>

const trackingStateSchema = a.strictObject({
  version: a.literal(1),
  hosts: a.array(projectRegistryDaemonPrivateDnsTrackedHostSchema),
  // Hash of the dnsmasq config the resolver confirmed loaded (reload exit 0).
  // Persisted only after a successful reload so a crash between write and
  // reload rewrites and reloads instead of assuming the new config is live.
  resolver: a.optional(a.strictObject({ contentHash: a.pipe(a.string(), a.regex(/^[0-9a-f]{64}$/)) })),
})

export type ProjectRegistryDaemonPrivateDnsTrackingState = a.InferOutput<typeof trackingStateSchema>

export { trackingStateSchema as projectRegistryDaemonPrivateDnsTrackingStateSchema }
