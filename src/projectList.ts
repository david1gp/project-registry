import { createResult, type Result } from "#result"
import type { Project } from "./Project.js"
import { projectRegistryStore } from "./projectRegistryStore.js"

export function projectList(): Result<Project[]> {
  return createResult([...projectRegistryStore.values()])
}
