import { createResult, createResultErrorCode, type Result } from "#result"
import { projectCaddyEntries } from "../project/projectCaddyEntries.js"
import { projectMigrate } from "../project/projectMigrate.js"

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
  const projectR = (() => {
    try {
      return projectMigrate(project)
    } catch {
      return undefined
    }
  })()
  if (projectR === undefined || !projectR.success) {
    return createResultErrorCode(op, "documentation configuration is invalid", "documentation.invalid-configuration")
  }

  const caddyEntries = projectCaddyEntries(projectR.data)
  if (caddyEntries.length === 0) {
    return createResultErrorCode(op, "documentation configuration is invalid", "documentation.invalid-configuration")
  }

  const docsEntries = caddyEntries.filter((entry) => entry.caddy.docs)
  if (docsEntries.length === 0) {
    return Object.assign(createResultErrorCode(op, "documentation is disabled", "documentation.disabled"), {
      hint: projectDocsEnablementHint(projectR.data.name, false),
    })
  }

  const activeDocsEntries = docsEntries.filter((entry) => !entry.caddy.disabled)
  if (activeDocsEntries.length === 0) {
    return Object.assign(createResultErrorCode(op, "documentation project is disabled", "projects.disabled"), {
      hint: projectDocsEnablementHint(projectR.data.name, true),
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
    const urls = activeDocsEntries.flatMap(({ caddy }) =>
      caddy.domains.map((domain) => {
        new URL(`${scheme}://${domain}/docs/${path}`)
        return `${scheme}://${domain}/docs/${path}`
      }),
    )
    return createResult({ urls })
  } catch {
    return createResultErrorCode(op, "documentation URL could not be generated", "documentation.url-generation-failed")
  }
}
