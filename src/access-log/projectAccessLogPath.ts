import { join } from "node:path"
import { createResult, type Result } from "#result"
import type { ProjectKey } from "../project/projectKey.js"
import { projectAccessLogId } from "./projectAccessLogId.js"
import { projectAccessLogRootValidate } from "./projectAccessLogRootValidate.js"

export function projectAccessLogPath(root: string, project: ProjectKey): Result<string> {
  const rootR = projectAccessLogRootValidate(root)
  if (!rootR.success) return rootR

  return createResult(join(rootR.data, "projects", projectAccessLogId(project), "access.jsonl"))
}
