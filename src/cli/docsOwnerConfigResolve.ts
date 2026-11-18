import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"

const schema = a.object({
  docs: a.object({
    rules: a.array(
      a.object({
        paths: a.array(a.pipe(a.string(), a.minLength(1))),
        owner: a.pipe(a.string(), a.regex(/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/)),
      }),
    ),
  }),
})

type Options = {
  environment: Readonly<Record<string, string | undefined>>
  cwd: string
  read?: (path: string) => Promise<string>
  realpath?: (path: string) => Promise<string>
}

export async function docsOwnerConfigResolve(options: Options): Promise<Result<string | undefined>> {
  const op = "docsOwnerConfigResolve"
  const { environment, cwd } = options
  const configHome = environment.XDG_CONFIG_HOME || (environment.HOME ? join(environment.HOME, ".config") : undefined)
  if (configHome === undefined) return createResult(undefined)
  const configPath = join(configHome, "project-registry", "config.json")
  let text: string
  try {
    text = await (options.read ?? ((path) => readFile(path, "utf8")))(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createResult(undefined)
    return createResultError(op, `Cannot read config ${configPath}: ${String(error)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return createResultError(op, `Invalid JSON in config ${configPath}.`)
  }
  const parsed = a.safeParse(schema, json)
  if (!parsed.success) return createResultError(op, `Invalid config ${configPath}: ${a.summarize(parsed.issues)}`)
  let physicalCwd = cwd
  try {
    physicalCwd = await (options.realpath ?? realpath)(cwd)
  } catch {
    // A missing or inaccessible real path does not prevent matching the given cwd.
  }
  const cwds = [resolve(cwd), resolve(physicalCwd)]
  // Shell PWD preserves a symlinked spelling that process.cwd() may discard.
  if (environment.PWD && isAbsolute(environment.PWD)) {
    try {
      const physicalPwd = await (options.realpath ?? realpath)(environment.PWD)
      if (resolve(physicalPwd) === resolve(physicalCwd)) cwds.push(resolve(environment.PWD))
    } catch {
      // Ignore stale or inaccessible PWD values.
    }
  }
  let bestLength = -1
  let owner: string | undefined
  for (const rule of parsed.output.docs.rules) {
    for (const path of rule.paths) {
      if ((path === "~" || path.startsWith("~/")) && !environment.HOME) continue
      const expanded =
        path === "~" ? environment.HOME! : path.startsWith("~/") ? join(environment.HOME!, path.slice(2)) : path
      if (!isAbsolute(expanded)) continue
      const prefix = resolve(expanded)
      if (prefix.length <= bestLength) continue
      if (cwds.some((candidate) => candidate === prefix || candidate.startsWith(prefix === sep ? sep : prefix + sep))) {
        bestLength = prefix.length
        owner = rule.owner
      }
    }
  }
  return createResult(owner)
}
