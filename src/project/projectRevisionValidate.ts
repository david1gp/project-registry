import { createResult, createResultError, type Result } from "#result"
import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"

const gitRevisionPattern = /^[0-9a-f]{40}$/

export function projectRevisionValidate(input: unknown, op: string): Result<ProjectRepositoryRevision> {
  if (typeof input !== "string" || (input !== "" && (input.length !== 40 || !gitRevisionPattern.test(input)))) {
    return createResultError(op, "revision must be an exact empty string or a 40-character lowercase Git revision")
  }
  return createResult(input)
}
