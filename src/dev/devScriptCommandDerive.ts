import type { DevCommandOverride } from "./DevCommandOverride.js"

/**
 * Derived argv. `projectRelativeCommand` means `command` is a path relative
 * to the project directory (bare `vite` → `node_modules/.bin/vite`) that the
 * caller must anchor to the real project directory and verify exists.
 */
export type DevScriptCommand = DevCommandOverride & { projectRelativeCommand?: boolean }

type DevTool = "vite" | "rsbuild" | "next" | "astro"

const devScriptBareBinPrefix = "node_modules/.bin/"
const devTools: readonly DevTool[] = ["vite", "rsbuild", "next", "astro"]
const scriptTokenPattern = /^[A-Za-z0-9_./:+=,@%-]+$/
const scriptReferencePattern = /^[A-Za-z0-9_.:-]+$/
const bunEnvFilePattern = /^--env-file=[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/
const toolPathPattern = /^\.\/node_modules\/(?:\.bin\/|[a-z@][a-z0-9@._/-]*\/)?([a-z]+)(?:\.(?:js|mjs|cjs))?$/
const hostValuePattern = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/
const maximumScriptDepth = 3

/** Flags each tool takes for port/host, and what the lease appends. */
const toolFlags: Record<
  DevTool,
  {
    subcommands: readonly (string | undefined)[]
    portFlags: readonly string[]
    hostFlags: readonly string[]
    hostValueOptional: boolean
    strictFlags: readonly string[]
    append: (port: number, host: string) => string[]
  }
> = {
  vite: {
    subcommands: [undefined, "dev", "serve"],
    portFlags: ["--port"],
    hostFlags: ["--host"],
    hostValueOptional: true,
    strictFlags: ["--strictPort", "--strict-port"],
    append: (port, host) => ["--port", String(port), "--strictPort", "--host", host],
  },
  rsbuild: {
    subcommands: ["dev"],
    portFlags: ["--port"],
    hostFlags: ["--host"],
    hostValueOptional: false,
    strictFlags: [],
    append: (port, host) => ["--port", String(port), "--host", host],
  },
  next: {
    subcommands: ["dev"],
    portFlags: ["--port", "-p"],
    hostFlags: ["--hostname", "-H"],
    hostValueOptional: false,
    strictFlags: [],
    append: (port, host) => ["--port", String(port), "--hostname", host],
  },
  astro: {
    subcommands: ["dev"],
    portFlags: ["--port"],
    hostFlags: ["--host"],
    hostValueOptional: true,
    strictFlags: [],
    append: (port, host) => ["--port", String(port), "--host", host],
  },
}

function toolOf(token: string): DevTool | undefined {
  if ((devTools as readonly string[]).includes(token)) return token as DevTool
  if (token.includes("..")) return undefined
  const match = toolPathPattern.exec(token)
  const name = match?.[1]
  return name !== undefined && (devTools as readonly string[]).includes(name) ? (name as DevTool) : undefined
}

function flagStrip(tool: DevTool, tokens: readonly string[]): string[] | undefined {
  const flags = toolFlags[tool]
  const kept: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token
    const inline = token.includes("=")
    if (flags.strictFlags.includes(name)) continue
    if (flags.portFlags.includes(name)) {
      if (!inline) {
        const next = tokens[index + 1]
        if (next === undefined || !/^\d+$/.test(next)) return undefined
        index += 1
      }
      continue
    }
    if (flags.hostFlags.includes(name)) {
      if (!inline) {
        const next = tokens[index + 1]
        if (next !== undefined && hostValuePattern.test(next) && !next.startsWith("-")) index += 1
        else if (!flags.hostValueOptional) return undefined
      }
      continue
    }
    kept.push(token)
  }
  return kept
}

function scriptTokens(script: string): string[] | undefined {
  const tokens = script.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0] === "") return undefined
  // Anything shell-shaped (chains, pipes, quotes, substitutions, env
  // assignments) is not a single tool invocation: leave it to `bun run dev`.
  if (tokens.some((token) => !scriptTokenPattern.test(token))) return undefined
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return undefined
  return tokens
}

function launcherSplit(tokens: readonly string[]): { launcher: string[]; rest: string[] } {
  const first = tokens[0]
  if (first === "bunx") {
    let index = 1
    while (tokens[index] === "--bun") index += 1
    return { launcher: tokens.slice(0, index), rest: tokens.slice(index) }
  }
  if (first === "bun") {
    let index = 1
    for (;;) {
      const token = tokens[index]
      if (token === "--bun" || (token !== undefined && bunEnvFilePattern.test(token))) {
        index += 1
        continue
      }
      break
    }
    // `bun x <tool>` is bunx; `bun run …` / `bun <script>` are handled by the
    // caller (script indirection) or fall back.
    if (tokens[index] === "x") index += 1
    return { launcher: tokens.slice(0, index), rest: tokens.slice(index) }
  }
  return { launcher: [], rest: [...tokens] }
}

/**
 * Derive a dev-server argv from a package.json `dev` script without any
 * per-project configuration. A single vite / rsbuild / next dev / astro dev
 * invocation (optionally behind `bun [--bun] [--env-file=…]` or `bunx`) runs
 * the tool directly with existing port/host/strict flags stripped and the
 * lease's flags appended; other flags (`--mode`, `--debug hmr`, …) are kept.
 * A script that is exactly `bun run <name>` / `npm run <name>` follows that
 * script (bounded depth). Anything else returns undefined so the caller falls
 * back to `bun run dev` with PORT/HOST env. A bare tool token returns the
 * relative `node_modules/.bin/<tool>` command; the caller anchors and checks
 * it.
 */
export function devScriptCommandDerive(options: {
  scripts: Readonly<Record<string, string>>
  port: number
  host: string
  scriptName?: string
}): DevScriptCommand | undefined {
  let script = options.scripts[options.scriptName ?? "dev"]
  for (let depth = 0; depth <= maximumScriptDepth; depth += 1) {
    if (typeof script !== "string") return undefined
    const tokens = scriptTokens(script)
    if (tokens === undefined) return undefined
    const reference =
      tokens.length === 3 && (tokens[0] === "bun" || tokens[0] === "npm" || tokens[0] === "pnpm") && tokens[1] === "run"
        ? tokens[2]
        : undefined
    if (reference !== undefined) {
      if (!scriptReferencePattern.test(reference) || !Object.hasOwn(options.scripts, reference)) return undefined
      script = options.scripts[reference]
      continue
    }
    const split = launcherSplit(tokens)
    let rest = split.rest
    let launcher = split.launcher
    // `bun run <tool> …` runs the package bin when no script has that name.
    if (
      launcher[0] === "bun" &&
      rest[0] === "run" &&
      rest[1] !== undefined &&
      !Object.hasOwn(options.scripts, rest[1])
    ) {
      launcher = [...launcher, "run"]
      rest = rest.slice(1)
    }
    const [toolToken, ...afterTool] = rest
    if (toolToken === undefined) return undefined
    const tool = toolOf(toolToken)
    if (tool === undefined) return undefined
    const flags = toolFlags[tool]
    const subcommand = afterTool[0] !== undefined && !afterTool[0].startsWith("-") ? afterTool[0] : undefined
    if (!flags.subcommands.includes(subcommand)) return undefined
    const strippedR = flagStrip(tool, afterTool)
    if (strippedR === undefined) return undefined
    const toolArgs = [...strippedR, ...flags.append(options.port, options.host)]
    if (launcher.length > 0) {
      return { command: launcher[0]!, args: [...launcher.slice(1), toolToken, ...toolArgs] }
    }
    const command = toolToken.startsWith("./") ? toolToken.slice(2) : `${devScriptBareBinPrefix}${toolToken}`
    return { command, args: toolArgs, projectRelativeCommand: true }
  }
  return undefined
}
