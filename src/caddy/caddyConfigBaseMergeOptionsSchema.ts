import * as a from "valibot"
import { caddyJsonObjectSchema } from "./caddyJsonObjectSchema.js"

export const caddyConfigBaseMergeOptionsSchema = a.strictObject({
  baseConfig: a.optional(caddyJsonObjectSchema),
  managedHosts: a.optional(a.array(a.pipe(a.string(), a.regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.?$/)))),
  targetServerName: a.optional(a.pipe(a.string(), a.minLength(1))),
})
export type CaddyConfigBaseMergeOptions = a.InferOutput<typeof caddyConfigBaseMergeOptionsSchema>
