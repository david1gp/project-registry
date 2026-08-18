import type { Project } from "./projectSchema.js"

export type ProjectKey = Readonly<Pick<Project, "owner" | "name">>

export function projectKey(project: ProjectKey): string {
  return JSON.stringify([project.owner, project.name])
}
