import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import type { Project } from "../project/Project.js"

/**
 * Resolve a project name by matching the current directory against project filesystem paths.
 * Prefers the longest matching path (exact or ancestor of the current directory).
 */
export function projectNameFromPath(projects: readonly Project[], cwd: string): Result<string> & { hint?: string } {
  const op = "projectNameFromPath"
  const resolvedCwd = resolve(cwd)

  let bestName: string | undefined
  let bestLength = -1

  for (const project of projects) {
    const projectPathValue = project.caddy?.path
    if (projectPathValue === undefined || projectPathValue === "") continue

    const projectPath = resolve(projectPathValue)
    const relativeCwd = relative(projectPath, resolvedCwd)
    const outsideProject = relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)
    const matches = relativeCwd === "" || (!outsideProject && !isAbsolute(relativeCwd))
    if (!matches || projectPath.length <= bestLength) continue

    bestLength = projectPath.length
    bestName = project.name
  }

  if (bestName === undefined) {
    const suggestedName = basename(resolvedCwd) || "<name>"
    const nameCollision = projects.some((project) => project.name === suggestedName)
    const pathCollision = projects.some((project) => {
      const projectPath = project.caddy?.path
      return projectPath !== undefined && projectPath !== "" && resolve(projectPath) === resolvedCwd
    })
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
