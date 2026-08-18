import * as a from "valibot"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { Actor } from "../access/Actor.js"
import type { Project } from "../project/Project.js"
import { projectSchema } from "../project/projectSchema.js"
import type { CaddyInspectionOptions } from "./CaddyInspectionOptions.js"

function actorIsValid(actor: unknown): actor is Actor {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return false
  const value = actor as Record<string, unknown>
  if (typeof value.username !== "string" || value.username.length === 0) return false
  if (value.subject !== null && (typeof value.subject !== "string" || value.subject.length === 0)) return false
  return value.role === "own" || value.role === "admin" || value.role === "superadmin"
}

function projectsFromSnapshot(value: unknown): Project[] | undefined {
  const projects = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Array.isArray((value as { projects?: unknown }).projects)
      ? (value as { projects: unknown[] }).projects
      : undefined
  if (projects === undefined) return undefined

  const parsed = a.safeParse(a.array(projectSchema), projects)
  return parsed.success ? parsed.output : undefined
}

export async function caddyVisibleProjects(options: CaddyInspectionOptions): PromiseResult<Project[]> {
  const op = "caddyVisibleProjects"
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return createResultError(op, "Caddy inspection options are invalid")
    }
    if (!actorIsValid(options.actor)) return createResultError(op, "actor mapping or current role is unavailable")

    const projectList =
      options.projectList ??
      (options.access && typeof options.access === "object" ? options.access.projectList : undefined)
    if (typeof projectList !== "function") {
      return createResultError(op, "visible project access is unavailable")
    }

    const listed = await projectList(options.actor)
    if (!listed || typeof listed !== "object" || listed.success !== true) {
      return createResultError(op, "visible project access is unavailable")
    }

    const projects = projectsFromSnapshot(listed.data)
    if (projects === undefined) return createResultError(op, "visible project snapshot is invalid")
    return createResult(projects)
  } catch {
    return createResultError(op, "visible project access is unavailable")
  }
}
