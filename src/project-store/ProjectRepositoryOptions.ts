import * as a from "valibot"

export const projectRepositoryOptionsSchema = a.strictObject({
  dir: a.pipe(a.string(), a.minLength(1)),
  autoPush: a.optional(a.boolean(), false),
  // Daemons own the worker lifecycle; short-lived/offline callers keep sync push.
  asyncPush: a.optional(a.boolean(), false),
  branch: a.optional(a.pipe(a.string(), a.minLength(1)), "main"),
})

export type ProjectRepositoryOptions = a.InferInput<typeof projectRepositoryOptionsSchema>
