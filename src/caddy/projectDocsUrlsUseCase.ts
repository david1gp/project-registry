import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { CaddyDocsUrlsUseCaseOptions } from "./CaddyDocsUrlsUseCaseOptions.js"
import { caddyVisibleProjects } from "./caddyVisibleProjects.js"
import { type ProjectDocsUrls, projectDocsUrls } from "./projectDocsUrls.js"

export async function projectDocsUrlsUseCase(options: CaddyDocsUrlsUseCaseOptions): PromiseResult<ProjectDocsUrls> {
  const op = "projectDocsUrlsUseCase"
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return createResultErrorCode(op, "documentation options are invalid", "documentation.invalid-options")
    }
    if (typeof options.projectName !== "string" || options.projectName.length === 0) {
      return createResultErrorCode(op, "documentation project is unavailable", "projects.not-found")
    }
    if (options.owner !== undefined && typeof options.owner !== "string") {
      return createResultErrorCode(op, "documentation project is unavailable", "projects.not-found")
    }

    const visibleR = await caddyVisibleProjects(options)
    if (!visibleR.success) return visibleR

    const matches = visibleR.data.filter(
      (project) =>
        project.name === options.projectName && (options.owner === undefined || project.owner === options.owner),
    )
    if (matches.length !== 1)
      return createResultErrorCode(op, "documentation project is unavailable", "projects.not-found")

    const project = matches[0]!
    const urlsR = projectDocsUrls(project, options.relativePath, { scheme: options.scheme })
    if (urlsR.success) return createResult(urlsR.data)
    return { ...urlsR, op }
  } catch {
    return createResultErrorCode(op, "documentation options are invalid", "documentation.invalid-options")
  }
}
