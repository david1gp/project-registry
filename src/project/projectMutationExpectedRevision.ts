import { createResult, createResultError, type Result } from "#result"
import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"
import { projectRevisionValidate } from "./projectRevisionValidate.js"

export function projectMutationExpectedRevision(
  input: unknown,
  currentRevision: unknown,
  op: string,
): Result<ProjectRepositoryRevision> {
  const currentRevisionR = projectRevisionValidate(currentRevision, op)
  if (!currentRevisionR.success) {
    return createResultError(op, `current revision is invalid: ${currentRevisionR.errorMessage}`)
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createResultError(op, "expectedRevision must be a non-empty string")
  }

  const expectedRevision = (input as Record<string, unknown>).expectedRevision
  const expectedRevisionR = projectRevisionValidate(expectedRevision, op)
  if (!expectedRevisionR.success) {
    return createResultError(op, "expectedRevision must be a non-empty string")
  }
  if (expectedRevisionR.data === "" && currentRevisionR.data !== "") {
    return createResultError(op, "expectedRevision must be a non-empty string")
  }

  return createResult(expectedRevisionR.data)
}
