import { createHash } from "node:crypto"
import type { ProjectKey } from "../project/projectKey.js"
import { projectKey } from "../project/projectKey.js"

export function projectAccessLogId(project: ProjectKey): string {
  return createHash("sha256").update(projectKey(project), "utf8").digest("hex")
}
