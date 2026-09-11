import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import type { Project } from "../project/Project.js"
import { projectCaddyEntries } from "../project/projectCaddyEntries.js"

function projectPaths(project: Project): string[] {
  return projectCaddyEntries(project)
    .map((entry) => entry.caddy.path)
    .filter((path): path is string => path !== undefined && path !== "")
}

/**
 * Resolve a project name by matching the current directory against project filesystem paths.
 * Prefers the longest matching path (exact or ancestor of the current directory), inspecting
 * every service of a project.
 */
export function projectNameFromPath(projects: readonly Project[], cwd: string): Result<string> & { hint?: string } {
  const op = "projectNameFromPath"
  const resolvedCwd = resolve(cwd)

  let bestName: string | undefined
  let bestLength = -1

  for (const project of projects) {
    for (const projectPathValue of projectPaths(project)) {
      const projectPath = resolve(projectPathValue)
      const relativeCwd = relative(projectPath, resolvedCwd)
      const outsideProject = relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)
      const matches = relativeCwd === "" || (!outsideProject && !isAbsolute(relativeCwd))
      if (!matches || projectPath.length <= bestLength) continue

      bestLength = projectPath.length
      bestName = project.name
    }
  }

  if (bestName === undefined) {
    const suggestedName = basename(resolvedCwd) || "<name>"
    const nameCollision = projects.some((project) => project.name === suggestedName)
    const pathCollision = projects.some((project) =>
      projectPaths(project).some((projectPath) => resolve(projectPath) === resolvedCwd),
    )
    const command =
      nameCollision || pathCollision
        ? `project-registry project create --name <name> --path ${resolvedCwd} --docs`
        : "project-registry project create --docs"
    return {
      ...createResultError(op, `no project matches cwd: ${resolvedCwd}`),
      hint: `Run: ${command}`,
    }
  }
  return createResult(bestName)
}
