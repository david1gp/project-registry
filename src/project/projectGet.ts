import { createResult, createResultErrorCode, type Result } from "#result"
import type { Project } from "./Project.js"
import type { ProjectKey } from "./projectKey.js"
import { projectKey } from "./projectKey.js"
import { projectKeyEqual } from "./projectKeyEqual.js"

export function projectGet(projects: readonly Project[], key: ProjectKey): Result<Project> {
  const op = "projectGet"
  const project = projects.find((item) => projectKeyEqual(item, key))
  if (!project) {
    return { ...createResultErrorCode(op, "project not found", "projects.not-found"), errorData: projectKey(key) }
  }
  return createResult(project)
}
