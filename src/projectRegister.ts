import { createResult, createResultError, type Result } from "#result"
import type { Project } from "./Project.js"
import { projectRegistryStore } from "./projectRegistryStore.js"

export function projectRegister(input: { name: string; description: string }): Result<Project> {
  const op = "projectRegister"
  const name = input.name.trim()
  if (name.length === 0) {
    return createResultError(op, "name must be non-empty", input.name)
  }
  if (projectRegistryStore.has(name)) {
    return createResultError(op, "project already registered", name)
  }
  const project: Project = {
    id: name,
    name,
    description: input.description,
  }
  projectRegistryStore.set(name, project)
  return createResult(project)
}
