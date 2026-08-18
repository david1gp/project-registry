import { createResult, type Result } from "#result"
import type { Project } from "./Project.js"
import { projectSort } from "./projectSort.js"

export function projectList(projects: readonly Project[]): Result<Project[]> {
  return createResult(projectSort(projects))
}
