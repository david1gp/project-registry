import { isAbsolute, relative, resolve } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import type { DevCommandOverride } from "./DevCommandOverride.js"
import type { DevProjectFilesystem } from "./DevProjectFilesystem.js"
import { devProjectFilesystemDefault } from "./devProjectFilesystemDefault.js"

// Loose objects: package.json carries many unrelated keys; only the dev
// script shape is validated. Never v.any(): unknown keys stay unparsed.
const packageJsonSchema = a.object({
  scripts: a.optional(
    a.object({
      dev: a.optional(a.string()),
    }),
  ),
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
}): Promise<Result<DevCommandOverride>> {
  const op = "devCommandResolve"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "dev command options are required")
  }
  // D3 inserts the registry-row `dev:{command}` metadata here, ahead of the
  // package.json fallback below. The override travels as an argv array so no
  // shell parsing is ever needed for registry-controlled commands either.
  if (options.override !== undefined) return overrideValidate(options.override, op)
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
    return createResultErrorCode(op, "dev package.json is missing", "request.invalid")
  }
  if (!underRoot(root, actual)) {
    return createResultError(op, "dev package.json escapes its projects root")
  }
  let raw: string
  try {
    raw = await filesystem.readFile(actual)
  } catch {
    return createResultErrorCode(op, "dev package.json is missing", "request.invalid")
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
  const script = scriptR.output.scripts?.dev
  if (typeof script !== "string" || script.trim() === "") {
    return createResultErrorCode(op, "dev package.json has no dev script", "request.invalid")
  }
  // The script body is validated present and non-blank, then executed through
  // the package manager (`bun run dev`): the body is never split or passed to
  // a shell, so quoting and chained commands in the script cannot escape the
  // argv boundary. Per-project port/host contracts stay Phase 0.2/E work.
  return createResult({ command: "bun", args: ["run", "dev"] })
}
