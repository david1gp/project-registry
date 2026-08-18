import { createResult, createResultError, type PromiseResult } from "#result"
import type { CaddyDocsUrlsUseCaseOptions } from "./CaddyDocsUrlsUseCaseOptions.js"
import { caddyVisibleProjects } from "./caddyVisibleProjects.js"
import { type ProjectDocsUrls, projectDocsUrls } from "./projectDocsUrls.js"

export async function projectDocsUrlsUseCase(options: CaddyDocsUrlsUseCaseOptions): PromiseResult<ProjectDocsUrls> {
  const op = "projectDocsUrlsUseCase"
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return createResultError(op, "documentation options are invalid")
    }
    if (typeof options.projectName !== "string" || options.projectName.length === 0) {
      return createResultError(op, "documentation project is unavailable")
    }
    if (options.owner !== undefined && typeof options.owner !== "string") {
      return createResultError(op, "documentation project is unavailable")
    }

    const visibleR = await caddyVisibleProjects(options)
    if (!visibleR.success) return visibleR

    const matches = visibleR.data.filter(
      (project) =>
        project.name === options.projectName && (options.owner === undefined || project.owner === options.owner),
    )
    if (matches.length !== 1) return createResultError(op, "documentation project is unavailable")

    const project = matches[0]!
    const urlsR = projectDocsUrls(project, options.relativePath, { scheme: options.scheme })
    if (urlsR.success) return createResult(urlsR.data)
    if (
      project.caddy !== undefined &&
      project.caddy !== null &&
      !project.caddy.disabled &&
      project.caddy.docs === true
    ) {
      return createResultError(op, "documentation URL could not be generated")
    }

    return createResultError(op, "documentation is unavailable")
  } catch {
    return createResultError(op, "documentation options are invalid")
  }
}
