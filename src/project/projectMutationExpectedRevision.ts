import { createResult, createResultErrorCode, type Result } from "#result"
import type { ProjectRepositoryRevision } from "../project-store/ProjectRepositoryRevision.js"
import { projectRevisionValidate } from "./projectRevisionValidate.js"

export function projectMutationExpectedRevision(
  input: unknown,
  currentRevision: unknown,
  op: string,
): Result<ProjectRepositoryRevision> {
  const currentRevisionR = projectRevisionValidate(currentRevision, op)
  if (!currentRevisionR.success) {
    return createResultErrorCode(op, `current revision is invalid: ${currentRevisionR.errorMessage}`, "request.invalid")
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createResultErrorCode(op, "expectedRevision must be a non-empty string", "request.invalid")
  }

  const expectedRevision = (input as Record<string, unknown>).expectedRevision
  const expectedRevisionR = projectRevisionValidate(expectedRevision, op)
  if (!expectedRevisionR.success) {
    return createResultErrorCode(op, "expectedRevision must be a non-empty string", "request.invalid")
  }
  if (expectedRevisionR.data === "" && currentRevisionR.data !== "") {
    return createResultErrorCode(op, "expectedRevision must be a non-empty string", "request.invalid")
  }

  return createResult(expectedRevisionR.data)
}
