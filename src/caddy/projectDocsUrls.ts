import * as a from "valibot"
import { createResult, createResultErrorCode, type Result } from "#result"
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

function projectDocsEnablementHint(name: string, projectDisabled: boolean): string {
  return `Run: project-registry project edit ${name}${projectDisabled ? " --enabled" : ""} --docs`
}

export function projectDocsUrls(project: unknown, relativePath: unknown, options?: unknown): Result<ProjectDocsUrls> {
  const op = "projectDocsUrls"
  const parsed = (() => {
    try {
      return a.safeParse(projectSchema, project)
    } catch {
      return undefined
    }
  })()
  if (parsed === undefined || !parsed.success) {
    return createResultErrorCode(op, "documentation configuration is invalid", "documentation.invalid-configuration")
  }

  const projectValue = parsed.output
  const caddy = projectValue.caddy
  if (caddy === undefined || caddy === null) {
    return createResultErrorCode(op, "documentation configuration is invalid", "documentation.invalid-configuration")
  }
  if (caddy.disabled) {
    return Object.assign(createResultErrorCode(op, "documentation project is disabled", "projects.disabled"), {
      hint: projectDocsEnablementHint(projectValue.name, true),
    })
  }
  if (caddy.docs !== true) {
    return Object.assign(createResultErrorCode(op, "documentation is disabled", "documentation.disabled"), {
      hint: projectDocsEnablementHint(projectValue.name, false),
    })
  }
  if (typeof relativePath !== "string")
    return createResultErrorCode(op, "documentation path is invalid", "documentation.invalid-path")

  let path = relativePath.trim()
  if (path === "") return createResultErrorCode(op, "documentation path is invalid", "documentation.invalid-path")
  if (path.startsWith("/docs/")) path = path.slice("/docs/".length)
  else if (path.startsWith("docs/")) path = path.slice("docs/".length)
  path = path.replace(/^\/+/, "")

  if (path.includes("..") || path.includes("\0") || !docsRelativePattern.test(path)) {
    return createResultErrorCode(op, "documentation path is invalid", "documentation.invalid-path")
  }

  const scheme = optionsScheme(options)
  if (scheme === undefined)
    return createResultErrorCode(op, "documentation URL options are invalid", "documentation.invalid-options")

  try {
    const urls = caddy.domains.map((domain) => {
      new URL(`${scheme}://${domain}/docs/${path}`)
      return `${scheme}://${domain}/docs/${path}`
    })
    return createResult({ urls })
  } catch {
    return createResultErrorCode(op, "documentation URL could not be generated", "documentation.url-generation-failed")
  }
}
