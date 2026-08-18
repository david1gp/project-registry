import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectSchema } from "../project/projectSchema.js"

const docsRelativePattern = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

export type ProjectDocsUrls = {
  urls: string[]
}

function optionsScheme(options: unknown): "https" | "http" | undefined {
  if (options === undefined) return "https"
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  const scheme = (options as { scheme?: unknown }).scheme
  if (scheme === undefined) return "https"
  return scheme === "https" || scheme === "http" ? scheme : undefined
}

export function projectDocsUrls(project: unknown, relativePath: unknown, options?: unknown): Result<ProjectDocsUrls> {
  const op = "projectDocsUrls"
  try {
    const parsed = a.safeParse(projectSchema, project)
    if (!parsed.success) return createResultError(op, "documentation project is invalid")
    const caddy = parsed.output.caddy
    if (caddy === undefined || caddy === null || caddy.disabled || caddy.docs !== true) {
      return createResultError(op, "documentation is unavailable")
    }
    if (typeof relativePath !== "string") return createResultError(op, "documentation path is invalid")

    let path = relativePath.trim()
    if (path === "") return createResultError(op, "documentation path is invalid")
    if (path.startsWith("/docs/")) path = path.slice("/docs/".length)
    else if (path.startsWith("docs/")) path = path.slice("docs/".length)
    path = path.replace(/^\/+/, "")

    if (path.includes("..") || path.includes("\0") || !docsRelativePattern.test(path)) {
      return createResultError(op, "documentation path is invalid")
    }

    const scheme = optionsScheme(options)
    if (scheme === undefined) return createResultError(op, "documentation URL options are invalid")
    return createResult({ urls: caddy.domains.map((domain) => `${scheme}://${domain}/docs/${path}`) })
  } catch {
    return createResultError(op, "documentation project is invalid")
  }
}
