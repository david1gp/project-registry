import * as a from "valibot"

const tailscaleSplitDnsStateSchema = a.object({
  version: a.literal(1),
  tailnet: a.pipe(a.string(), a.minLength(1)),
  nodeAddress: a.pipe(a.string(), a.ipv4()),
  savedAt: a.pipe(a.string(), a.minLength(1)),
  prior: a.record(a.string(), a.nullable(a.array(a.string()))),
  // Removals record applied:null (entry cleared); applies record the new addresses.
  applied: a.record(a.string(), a.nullable(a.array(a.string()))),
})

export type TailscaleSplitDnsState = a.InferOutput<typeof tailscaleSplitDnsStateSchema>

export { tailscaleSplitDnsStateSchema }
