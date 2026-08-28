import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectDomainValidate } from "../project/projectDomainValidate.js"
import type { UserDefaultDomain } from "./UserDefaultDomain.js"
import { userDefaultDomainPath } from "./userDefaultDomainPath.js"
import { userDefaultDomainSchema } from "./userDefaultDomainSchema.js"

export function userDefaultDomainValidate(input: unknown): Result<UserDefaultDomain> {
  const op = "userDefaultDomainValidate"
  const parsed = a.safeParse(userDefaultDomainSchema, input)
  if (!parsed.success) return createResultError(op, a.summarize(parsed.issues))

  const ownerR = userDefaultDomainPath(parsed.output.owner)
  if (!ownerR.success) return createResultError(op, ownerR.errorMessage)
  if (parsed.output.domain === null) return createResult({ ...parsed.output })

  const domainR = projectDomainValidate(parsed.output.domain, op)
  if (!domainR.success) return domainR
  return createResult({ owner: parsed.output.owner, domain: domainR.data })
}
