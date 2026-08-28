import { createResult, createResultError, type Result } from "#result"
import { projectDomainNormalize } from "./projectDomainNormalize.js"

const domainLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

export function projectDomainValidate(input: unknown, op = "projectDomainValidate"): Result<string> {
  if (typeof input !== "string") return createResultError(op, "domain must be a string")

  const domain = projectDomainNormalize(input)
  if (
    domain.length === 0 ||
    domain.length > 253 ||
    domain.split(".").some((label) => !domainLabelPattern.test(label))
  ) {
    return createResultError(op, "domain is invalid", domain)
  }
  return createResult(domain)
}
