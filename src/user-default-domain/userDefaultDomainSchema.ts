import * as a from "valibot"

const ownerSchema = a.pipe(a.string(), a.minLength(1))
const domainSchema = a.nullable(a.pipe(a.string(), a.minLength(1)))

export const userDefaultDomainSchema = a.strictObject({
  owner: ownerSchema,
  domain: domainSchema,
})

export type UserDefaultDomain = a.InferOutput<typeof userDefaultDomainSchema>
