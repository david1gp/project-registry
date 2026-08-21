import { posix } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectAccessLogRootSchema } from "./projectAccessLogRootSchema.js"

export function projectAccessLogRootValidate(root: unknown, repositoryPath?: string): Result<string> {
  const op = "projectAccessLogRootValidate"
  const parsed = a.safeParse(projectAccessLogRootSchema, root)
  if (!parsed.success) return createResultError(op, a.summarize(parsed.issues))
  if (repositoryPath === undefined) return createResult(parsed.output)

  const repository = posix.normalize(repositoryPath)
  if (repository === "/" || parsed.output === repository || parsed.output.startsWith(`${repository}/`)) {
    return createResultError(op, "access log root must not be equal to or inside the Git repository")
  }

  return createResult(parsed.output)
}
