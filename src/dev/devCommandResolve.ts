import { isAbsolute, relative, resolve } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import { projectServiceDevCommandValidate } from "../project/projectServiceDevCommandValidate.js"
import type { DevCommandOverride } from "./DevCommandOverride.js"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import { devProjectFilesystemDefault } from "./devProjectFilesystemDefault.js"
import { devScriptCommandDerive } from "./devScriptCommandDerive.js"

// Loose objects: package.json carries many unrelated keys; only the scripts
// shape is validated. Non-string script values are dropped, never executed.
const packageJsonSchema = a.object({
  scripts: a.optional(a.record(a.string(), a.unknown())),
})

function underRoot(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate)
  return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))
}

function overrideValidate(override: DevCommandOverride, op: string): Result<DevCommandOverride> {
  if (typeof override.command !== "string" || override.command.trim() === "") {
    return createResultErrorCode(op, "dev command override is invalid", "request.invalid")
  }
  if (!Array.isArray(override.args) || override.args.some((entry) => typeof entry !== "string")) {
    return createResultErrorCode(op, "dev command override is invalid", "request.invalid")
  }
  return createResult({ command: override.command, args: [...override.args] })
}

export async function devCommandResolve(options: {
  directory: string
  projectsRoot?: string
  filesystem?: DevProjectFilesystem
  override?: DevCommandOverride
  rowCommand?: string
  port?: number
  host?: string
  project?: string
}): Promise<Result<DevCommandOverride>> {
  const op = "devCommandResolve"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "dev command options are required")
  }
  // Resolution order: explicit argv override, then the registry-row
  // `dev:{command}` metadata, then the package.json `dev` script fallback.
  // The override travels as an argv array so no shell parsing is ever needed
  // for registry-controlled commands either.
  if (options.override !== undefined) return overrideValidate(options.override, op)
  if (options.rowCommand !== undefined) return rowCommandResolve(options, op)
  if (typeof options.directory !== "string" || options.directory.trim() === "") {
    return createResultError(op, "dev project directory is required")
  }
  if (typeof options.projectsRoot !== "string" || options.projectsRoot.trim() === "") {
    return createResultError(op, "dev project directory is unavailable")
  }
  const filesystem = options.filesystem ?? devProjectFilesystemDefault()
  const root = resolve(options.projectsRoot)
  const manifestPath = resolve(options.directory, "package.json")
  let actual: string
  try {
    actual = await filesystem.realpath(manifestPath)
  } catch {
    return missingContract(op, options.project, "dev package.json is missing")
  }
  if (!underRoot(root, actual)) {
    return createResultError(op, "dev package.json escapes its projects root")
  }
  let raw: string
  try {
    raw = await filesystem.readFile(actual)
  } catch {
    return missingContract(op, options.project, "dev package.json is missing")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return createResultErrorCode(op, "dev package.json is invalid", "request.invalid")
  }
  const scriptR = a.safeParse(packageJsonSchema, parsed)
  if (!scriptR.success) {
    return createResultErrorCode(op, "dev package.json is invalid", "request.invalid")
  }
  const scripts: Record<string, string> = {}
  for (const [name, body] of Object.entries(scriptR.output.scripts ?? {})) {
    if (typeof body === "string") scripts[name] = body
  }
  const script = scripts.dev
  if (typeof script !== "string" || script.trim() === "") {
    return missingContract(op, options.project, "dev package.json has no dev script")
  }
  // Generic derivation: a single vite/rsbuild/next/astro invocation runs the
  // tool directly with the lease's port/host flags (tools ignore PORT env).
  // Script bodies are tokenized only when every token is shell-inert; nothing
  // is ever passed to a shell.
  if (Number.isInteger(options.port) && typeof options.host === "string" && options.host !== "") {
    const derived = devScriptCommandDerive({ scripts, port: options.port as number, host: options.host })
    if (derived !== undefined) {
      if (derived.projectRelativeCommand !== true) {
        return createResult({ command: derived.command, args: derived.args })
      }
      const directory = resolve(options.directory)
      const binary = resolve(directory, derived.command)
      try {
        const binaryReal = await filesystem.realpath(binary)
        if (underRoot(directory, binary) && underRoot(root, binaryReal)) {
          return createResult({ command: binary, args: derived.args })
        }
      } catch {
        // Tool not installed locally: fall through to the package manager.
      }
    }
  }
  // Fallback: run through the package manager (`bun run dev`) with PORT/HOST
  // env; the body is never split or passed to a shell here.
  return createResult({ command: "bun", args: ["run", "dev"] })
}

function missingContract(op: string, project: string | undefined, cause: string): Result<DevCommandOverride> {
  if (project === undefined) return createResultErrorCode(op, cause, "request.invalid")
  return createResultErrorCode(op, `dev command for project ${project} is not configured (${cause})`, "request.invalid")
}

function rowCommandResolve(
  options: {
    rowCommand?: string
    port?: number
    host?: string
  },
  op: string,
): Result<DevCommandOverride> {
  const tokensR = projectServiceDevCommandValidate(options.rowCommand)
  if (!tokensR.success) return { ...tokensR, op }
  const tokens = tokensR.data
  if (tokens.some((token) => token.includes("{port}")) && !Number.isInteger(options.port)) {
    return createResultErrorCode(op, "dev command placeholders need a port", "request.invalid")
  }
  if (tokens.some((token) => token.includes("{host}")) && (typeof options.host !== "string" || options.host === "")) {
    return createResultErrorCode(op, "dev command placeholders need a host", "request.invalid")
  }
  const substituted = tokens.map((token) =>
    token.replaceAll("{port}", String(options.port)).replaceAll("{host}", options.host ?? ""),
  )
  const command = substituted[0]
  if (command === undefined) return createResultErrorCode(op, "dev command must not be blank", "request.invalid")
  return createResult({ command, args: substituted.slice(1) })
}
