import { existsSync, realpathSync } from "node:fs"
import * as os from "node:os"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import pkg from "../package.json" with { type: "json" }

type PackageMetadata = typeof pkg & {
  author?: string | { name?: string; url?: string }
  engines?: Record<string, string>
}
type PackageAuthor = string | { name?: string; url?: string }

const packageMetadata = pkg as PackageMetadata

function executableResolve(): { entrypoint: string; target?: string } {
  const entrypoint = process.argv[1]
  if (entrypoint === undefined) return { entrypoint: "unavailable" }
  const resolvedEntrypoint = resolve(entrypoint)
  try {
    return { entrypoint: resolvedEntrypoint, target: realpathSync(resolvedEntrypoint) }
  } catch {
    return { entrypoint: resolvedEntrypoint }
  }
}

function installationTypeResolve(executableTarget: string | undefined): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  if (existsSync(resolve(packageRoot, ".git"))) return "development checkout"
  if (executableTarget !== undefined && !relative(packageRoot, executableTarget).startsWith(".."))
    return "package installation"
  return "unknown"
}

function authorRender(): string {
  const author = packageMetadata.author as PackageAuthor | undefined
  if (typeof author === "string") return author
  if (author !== undefined) {
    return [author.name, author.url].filter(Boolean).join(" — ") || "unavailable"
  }
  return "unavailable"
}

function requirementsRender(): string {
  return (
    Object.entries(packageMetadata.engines ?? {})
      .map(([runtime, requirement]) => `${runtime} ${requirement}`)
      .join(", ") || "unavailable"
  )
}

export function projectRegistryVersionMetadataRender(binaryName: string): string {
  const executable = executableResolve()
  const runtime = typeof Bun === "undefined" ? `${process.release.name} ${process.version}` : `bun ${Bun.version}`
  const project = packageMetadata.homepage ?? packageMetadata.repository?.url ?? "unavailable"
  const lines = [
    `${binaryName} ${packageMetadata.version}`,
    `user agent: ${packageMetadata.name}/${packageMetadata.version}`,
    `executable: ${executable.entrypoint}`,
    `executable target: ${executable.target ?? "unavailable"}`,
    `version: ${packageMetadata.version}`,
    `description: ${packageMetadata.description ?? "unavailable"}`,
    `author: ${authorRender()}`,
    `license: ${packageMetadata.license ?? "unavailable"}`,
    `project: ${project}`,
    `installation type: ${installationTypeResolve(executable.target)}`,
    `runtime: ${runtime}`,
    `runtime requirements: ${requirementsRender()}`,
    `platform: ${process.platform} ${process.arch} (OS release ${os.release()})`,
  ]
  return `${lines.join("\n")}\n`
}
