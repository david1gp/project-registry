import * as a from "valibot"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const jsonValueSchema: a.GenericSchema<JsonValue> = a.lazy(() =>
  a.union([
    a.string(),
    a.pipe(a.number(), a.finite()),
    a.boolean(),
    a.null(),
    a.array(jsonValueSchema),
    a.record(a.string(), jsonValueSchema),
  ]),
)

/** Lossless JSON envelope: do not model or strip Caddy/plugin-specific options. */
export const caddyJsonObjectSchema = a.record(a.string(), jsonValueSchema)
export type CaddyJsonObject = a.InferOutput<typeof caddyJsonObjectSchema>
