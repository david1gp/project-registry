import { createResult, createResultError, type Result } from "#result"
import type { ProjectRegistryCliCaddyOptions } from "./ProjectRegistryCliCaddyOptions.js"
import type { ProjectRegistryCliInvocation } from "./ProjectRegistryCliInvocation.js"

const projectNamePattern = /^[a-z0-9][a-z0-9-]*$/
const projectNameRequirement =
  "Project names must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens."
const projectNameHint = "Use a name such as 'my-project'."
const ownerPattern = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/
const maximumAccessLogLimit = 1_000
const maximumAccessLogCursorLength = 4_096

function positiveIntegerParse(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function portParse(value: string | undefined): number | undefined {
  const parsed = positiveIntegerParse(value)
  return parsed !== undefined && parsed <= 65535 ? parsed : undefined
}

function finiteNumberParse(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionValue(argument: string, name: string, args: readonly string[], index: number): string | undefined {
  return argument === name ? args[index + 1] : argument.slice(`${name}=`.length)
}

function optionUsesNextArgument(argument: string): boolean {
  return !argument.includes("=")
}

function projectNameError(op: string): Extract<Result<never>, { success: false }> & { hint: string } {
  return { ...createResultError(op, projectNameRequirement), hint: projectNameHint }
}

function projectNameOptionError(op: string): Extract<Result<never>, { success: false }> & { hint: string } {
  return {
    ...createResultError(op, `Option --name requires a valid project name. ${projectNameRequirement}`),
    hint: projectNameHint,
  }
}

export function projectRegistryCliArgumentsParse(args: readonly string[]): Result<ProjectRegistryCliInvocation> {
  const op = "projectRegistryCliArgumentsParse"
  const positionals: string[] = []
  const domains: string[] = []
  const headerUpEntries: string[] = []
  const labels: Record<string, string> = {}
  const removeLabels: string[] = []
  const seen = new Set<string>()
  const booleans = new Set<string>()
  let socket: string | undefined
  let limit: number | undefined
  let flagName: string | undefined
  let port: number | undefined
  let path: string | undefined
  let owner: string | undefined
  let before: string | undefined
  let kind: "proxy" | "static" | undefined
  let access: "internal" | "external" | undefined
  let flushInterval: number | undefined
  let json = false
  let help = false
  let version = false
  let hasLabels = false
  let clearLabels = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (["--json", "--help", "-h", "--version", "-V"].includes(argument)) {
      const key = argument === "-h" ? "--help" : argument === "-V" ? "--version" : argument
      if (seen.has(key)) return createResultError(op, `Option ${key} may only be provided once.`)
      seen.add(key)
      if (key === "--json") json = true
      if (key === "--help") help = true
      if (key === "--version") version = true
      continue
    }

    const booleanNames = [
      "--docs",
      "--no-docs",
      "--browse",
      "--no-browse",
      "--disabled",
      "--enabled",
      "--spa",
      "--no-spa",
      "--http",
      "--clear-labels",
    ]
    if (booleanNames.includes(argument)) {
      if (booleans.has(argument)) return createResultError(op, `Option ${argument} may only be provided once.`)
      booleans.add(argument)
      if (argument === "--clear-labels") clearLabels = true
      continue
    }

    const optionNames = [
      "--socket",
      "--limit",
      "--name",
      "--port",
      "--domain",
      "--path",
      "--kind",
      "--access",
      "--header-up",
      "--label",
      "--remove-label",
      "--flush-interval",
      "--owner",
      "--before",
    ]
    const option = optionNames.find((name) => argument === name || argument.startsWith(`${name}=`))
    if (option !== undefined) {
      const repeatable =
        option === "--domain" || option === "--header-up" || option === "--label" || option === "--remove-label"
      if (!repeatable && seen.has(option)) return createResultError(op, `Option ${option} may only be provided once.`)
      seen.add(option)
      const value = optionValue(argument, option, args, index)
      if (optionUsesNextArgument(argument)) index += 1

      if (option === "--socket") {
        if (value === undefined || value.length === 0 || value.startsWith("-")) {
          return createResultError(op, "Option --socket requires a path.")
        }
        socket = value
        continue
      }
      if (option === "--limit") {
        limit = positiveIntegerParse(value)
        if (limit === undefined) return createResultError(op, "Option --limit requires a positive integer.")
        continue
      }
      if (option === "--name") {
        if (value === undefined || !projectNamePattern.test(value)) {
          return projectNameOptionError(op)
        }
        flagName = value
        continue
      }
      if (option === "--port") {
        port = portParse(value)
        if (port === undefined) return createResultError(op, "Option --port requires an integer from 1 through 65535.")
        continue
      }
      if (option === "--domain") {
        if (value === undefined || value.length === 0 || value.startsWith("-")) {
          return createResultError(op, "Option --domain requires a hostname.")
        }
        domains.push(value)
        continue
      }
      if (option === "--path") {
        if (value === undefined || value.startsWith("-")) return createResultError(op, "Option --path requires a path.")
        path = value
        continue
      }
      if (option === "--owner") {
        if (value === undefined || !ownerPattern.test(value)) {
          return createResultError(op, "Option --owner requires a valid Unix username.")
        }
        owner = value
        continue
      }
      if (option === "--before") {
        if (
          value === undefined ||
          value.length === 0 ||
          (optionUsesNextArgument(argument) && value.startsWith("-")) ||
          value.length > maximumAccessLogCursorLength
        ) {
          return createResultError(op, "Option --before requires a bounded cursor.")
        }
        before = value
        continue
      }
      if (option === "--kind") {
        if (value !== "proxy" && value !== "static") {
          return createResultError(op, "Option --kind must be proxy or static.")
        }
        kind = value
        continue
      }
      if (option === "--access") {
        if (value !== "internal" && value !== "external") {
          return createResultError(op, "Option --access must be internal or external.")
        }
        access = value
        continue
      }
      if (option === "--header-up") {
        if (value === undefined || !value.includes("=")) {
          return createResultError(
            op,
            `Option --header-up requires K=V${value === undefined ? "." : `, got: ${value}.`}`,
          )
        }
        headerUpEntries.push(value)
        continue
      }
      if (option === "--label") {
        if (value === undefined || !value.includes("=")) {
          return createResultError(op, `Option --label requires K=V${value === undefined ? "." : `, got: ${value}.`}`)
        }
        const separator = value.indexOf("=")
        const key = value.slice(0, separator)
        if (key.trim() === "") return createResultError(op, "Option --label requires a non-blank key.")
        Object.defineProperty(labels, key, {
          configurable: true,
          enumerable: true,
          value: value.slice(separator + 1),
          writable: true,
        })
        hasLabels = true
        continue
      }
      if (option === "--remove-label") {
        if (value === undefined || value.trim() === "")
          return createResultError(op, "Option --remove-label requires a non-blank key.")
        removeLabels.push(value)
        continue
      }

      flushInterval = finiteNumberParse(value)
      if (flushInterval === undefined) return createResultError(op, "Option --flush-interval requires a finite number.")
      continue
    }

    if (argument.startsWith("-")) return createResultError(op, `Unknown option: ${argument}.`)
    positionals.push(argument)
  }

  if (help && version) return createResultError(op, "Options --help and --version cannot be combined.")
  if (help) return createResult({ command: { kind: "help" }, json, socket })
  if (version) return createResult({ command: { kind: "version" }, json, socket })
  if (positionals.length === 0) return createResultError(op, "A command is required.")

  const pairValues: Array<[string, string, keyof ProjectRegistryCliCaddyOptions]> = [
    ["--docs", "--no-docs", "docs"],
    ["--browse", "--no-browse", "browse"],
    ["--disabled", "--enabled", "disabled"],
    ["--spa", "--no-spa", "spa"],
  ]
  const caddy: ProjectRegistryCliCaddyOptions = {}
  if (port !== undefined) caddy.port = port
  if (domains.length > 0) caddy.domains = domains
  if (path !== undefined) caddy.path = path
  if (kind !== undefined) caddy.kind = kind
  if (access !== undefined) caddy.access = access
  if (flushInterval !== undefined) caddy.flushInterval = flushInterval
  if (headerUpEntries.length > 0) {
    caddy.headerUp = {}
    for (const entry of headerUpEntries) {
      const separator = entry.indexOf("=")
      caddy.headerUp[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
  }
  for (const [enabled, disabled, key] of pairValues) {
    if (booleans.has(enabled) && booleans.has(disabled)) {
      return createResultError(op, `Options ${enabled} and ${disabled} cannot be combined.`)
    }
    const value = booleans.has(enabled) ? true : booleans.has(disabled) ? false : undefined
    if (value === undefined) continue
    if (key === "docs") caddy.docs = value
    if (key === "browse") caddy.browse = value
    if (key === "disabled") caddy.disabled = value
    if (key === "spa") caddy.spa = value
  }

  const [subject, action, value, ...extra] = positionals
  const hasCaddyOptions = Object.keys(caddy).length > 0
  const hasOnlyPortOption = port !== undefined && Object.keys(caddy).length === 1
  const hasLabelOptions = hasLabels || removeLabels.length > 0 || clearLabels
  const hasMutationOptions = hasCaddyOptions || flagName !== undefined || hasLabelOptions
  const hasAccessLogOptions = owner !== undefined || before !== undefined
  const hasHttp = booleans.has("--http")

  if (
    subject === "project" &&
    action === "list" &&
    value === undefined &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    return createResult({ command: { kind: "project-list" }, json, socket })
  }
  if (
    subject === "project" &&
    action === "get" &&
    value !== undefined &&
    extra.length === 0 &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    if (!projectNamePattern.test(value)) return projectNameError(op)
    return createResult({ command: { kind: "project-get", name: value }, json, socket })
  }
  if (
    subject === "project" &&
    action === "access-logs" &&
    value !== undefined &&
    extra.length === 0 &&
    !hasCaddyOptions &&
    flagName === undefined &&
    !hasHttp
  ) {
    if (!projectNamePattern.test(value)) return projectNameError(op)
    if (limit !== undefined && limit > maximumAccessLogLimit) {
      return createResultError(op, "Option --limit for access logs must not exceed 1000.")
    }
    return createResult({ command: { kind: "project-access-logs", name: value, owner, limit, before }, json, socket })
  }
  if (
    subject === "project" &&
    action === "create" &&
    value === undefined &&
    limit === undefined &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    if (flagName === undefined) return createResultError(op, "Project create requires --name.")
    if (caddy.domains === undefined) return createResultError(op, "Project create requires at least one --domain.")
    if (removeLabels.length > 0 || clearLabels) {
      return createResultError(op, "Options --remove-label and --clear-labels are only valid for project edit.")
    }
    return createResult({
      command: { kind: "project-create", name: flagName, caddy, ...(hasLabels ? { labels } : {}) },
      json,
      socket,
    })
  }
  if (
    subject === "project" &&
    action === "edit" &&
    value !== undefined &&
    extra.length === 0 &&
    limit === undefined &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    if (!projectNamePattern.test(value)) return projectNameError(op)
    if (flagName !== undefined) return createResultError(op, "Option --name cannot edit an immutable project name.")
    return createResult({
      command: {
        kind: "project-edit",
        name: value,
        caddy,
        ...(hasLabels ? { labels } : {}),
        ...(removeLabels.length > 0 ? { removeLabels } : {}),
        ...(clearLabels ? { clearLabels: true } : {}),
      },
      json,
      socket,
    })
  }
  if (
    subject === "delete" &&
    action === undefined &&
    value === undefined &&
    extra.length === 0 &&
    hasOnlyPortOption &&
    port !== undefined &&
    flagName === undefined &&
    limit === undefined &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    return createResult({ command: { kind: "project-delete-by-port", port }, json, socket })
  }
  if (
    subject === "project" &&
    action === "delete" &&
    value !== undefined &&
    extra.length === 0 &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    if (!projectNamePattern.test(value)) return createResultError(op, "Project name is invalid.")
    return createResult({ command: { kind: "project-delete", name: value }, json, socket })
  }
  if (
    subject === "project" &&
    action === "history" &&
    value !== undefined &&
    extra.length === 0 &&
    !hasMutationOptions &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    if (!projectNamePattern.test(value)) return projectNameError(op)
    return createResult({ command: { kind: "project-history", name: value, limit }, json, socket })
  }
  if (subject === "history" && action === undefined && !hasMutationOptions && !hasAccessLogOptions && !hasHttp) {
    return createResult({ command: { kind: "history", limit }, json, socket })
  }
  if (
    subject === "docs" &&
    action !== undefined &&
    value === undefined &&
    extra.length === 0 &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions
  ) {
    return createResult({ command: { kind: "docs-local", path: action, http: hasHttp }, json, socket })
  }
  if (
    subject === "docs" &&
    action !== undefined &&
    value !== undefined &&
    extra.length === 0 &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions
  ) {
    if (!projectNamePattern.test(action)) return projectNameError(op)
    return createResult({ command: { kind: "docs", name: action, path: value, http: hasHttp }, json, socket })
  }
  if (
    subject === "config" &&
    value === undefined &&
    extra.length === 0 &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    return createResult({ command: { kind: "config", selector: action }, json, socket })
  }
  if (
    subject === "regenerate" &&
    action === undefined &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    return createResult({ command: { kind: "regenerate" }, json, socket })
  }
  if (
    subject === "status" &&
    action === undefined &&
    limit === undefined &&
    !hasMutationOptions &&
    !hasAccessLogOptions &&
    !hasHttp
  ) {
    return createResult({ command: { kind: "status" }, json, socket })
  }
  return createResultError(op, `Unknown command or invalid syntax: ${positionals.join(" ")}.`)
}
