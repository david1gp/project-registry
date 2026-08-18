import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectCollisions } from "./projectCollisions.js"
import type { ProjectKey } from "./projectKey.js"
import type { Project } from "./projectSchema.js"
import { projectSchema } from "./projectSchema.js"

export type ProjectValidateOptions = {
  projects?: readonly Project[]
  excludeKey?: ProjectKey
  excludeProject?: Project
}

export function projectValidate(input: unknown, options: ProjectValidateOptions = {}): Result<Project> {
  const op = "projectValidate"
  const parsed = a.safeParse(projectSchema, input)
  if (!parsed.success) return createResultError(op, a.summarize(parsed.issues))

  if (options.projects !== undefined) {
    for (const project of options.projects) {
      const existing = a.safeParse(projectSchema, project)
      if (!existing.success) return createResultError(op, a.summarize(existing.issues))
    }

    const collisions = projectCollisions(options.projects, {
      excludeKey: options.excludeKey,
      excludeProject: options.excludeProject,
      replacement: parsed.output,
    })
    if (!collisions.success) return createResultError(op, collisions.errorMessage)
  }

  return createResult(parsed.output)
}
