import * as v from "valibot"

type ProjectAccessLogJsonValue =
  | null
  | boolean
  | number
  | string
  | ProjectAccessLogJsonValue[]
  | { [key: string]: ProjectAccessLogJsonValue }

const projectAccessLogJsonValueSchema: v.GenericSchema<ProjectAccessLogJsonValue> = v.lazy(() =>
  v.union([
    v.null_(),
    v.boolean(),
    v.pipe(v.number(), v.finite()),
    v.string(),
    v.array(projectAccessLogJsonValueSchema),
    projectAccessLogJsonObjectSchema,
  ]),
)

const projectAccessLogJsonObjectSchema = v.pipe(
  v.custom<{ [key: string]: ProjectAccessLogJsonValue }>((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }),
  v.record(v.string(), projectAccessLogJsonValueSchema),
)

const projectAccessLogRecordSchema = projectAccessLogJsonObjectSchema

export const projectAccessLogPageSchema = v.object({
  records: v.array(projectAccessLogRecordSchema),
  next: v.optional(v.string()),
  partial: v.boolean(),
  malformedLines: v.pipe(v.number(), v.finite(), v.safeInteger(), v.minValue(0)),
})

export type ProjectAccessLogPage = v.InferOutput<typeof projectAccessLogPageSchema>
