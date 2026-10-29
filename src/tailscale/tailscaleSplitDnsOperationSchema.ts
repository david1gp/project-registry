import * as a from "valibot"

export const tailscaleSplitDnsOperationSchema = a.union([
  a.literal("split-dns-read"),
  a.literal("split-dns-plan"),
  a.literal("split-dns-patch"),
  a.literal("split-dns-verify"),
  a.literal("state-read"),
  a.literal("state-write"),
  a.literal("request"),
])

export type TailscaleSplitDnsOperation = a.InferOutput<typeof tailscaleSplitDnsOperationSchema>
