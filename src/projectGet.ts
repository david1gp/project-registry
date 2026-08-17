import { createResult, createResultError, type Result } from "#result"
import type { Project } from "./Project.js"
import { projectRegistryStore } from "./projectRegistryStore.js"

export function projectGet(id: string): Result<Project> {
  const op = "projectGet"
  const project = projectRegistryStore.get(id)
  if (!project) {
    return createResultError(op, "project not found", id)
  }
  return createResult(project)
}
