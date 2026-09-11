import * as a from "valibot"
import { createResult, createResultErrorCode, type Result } from "#result"
import type { Project as ProjectAny } from "./Project.js"
import { projectCollisions } from "./projectCollisions.js"
import type { ProjectKey } from "./projectKey.js"
import { projectMigrate } from "./projectMigrate.js"
import type { Project } from "./projectSchema.js"
import { projectSchema } from "./projectSchema.js"

export type ProjectValidateOptions = {
  projects?: readonly ProjectAny[]
  excludeKey?: ProjectKey
  excludeProject?: ProjectAny
}

export function projectValidate(input: unknown, options: ProjectValidateOptions = {}): Result<Project> {
  const op = "projectValidate"
  const parsed = a.safeParse(projectSchema, input)
  if (!parsed.success) return createResultErrorCode(op, a.summarize(parsed.issues), "request.invalid")

  if (options.projects !== undefined) {
    for (const project of options.projects) {
      const existing = projectMigrate(project)
      if (!existing.success) return createResultErrorCode(op, existing.errorMessage, "request.invalid")
    }
  }

  const collisions = projectCollisions(options.projects ?? [], {
    excludeKey: options.excludeKey,
    excludeProject: options.excludeProject,
    replacement: parsed.output,
  })
  if (!collisions.success) return { ...collisions, op }

  return createResult(parsed.output)
}
