import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import { projectDocsPagePathIsValid } from "../docs/projectDocsPagePathIsValid.js"

export function docsLogicalPagePathResolve(inputPath: string): Result<string> {
  const op = "docsLogicalPagePathResolve"
  if (inputPath === "" || inputPath.includes("\\")) {
    return createResultError(op, "Documentation source must use a route-safe relative Markdown path.")
  }

  const cwd = resolve(process.cwd())
  const sourcePath = resolve(cwd, inputPath)
  const cwdRelativePath = relative(cwd, sourcePath)
  const isOutsideCwd = cwdRelativePath === ".." || cwdRelativePath.startsWith(`..${sep}`) || isAbsolute(cwdRelativePath)
  const pagePath = isAbsolute(inputPath) || isOutsideCwd ? basename(sourcePath) : cwdRelativePath.split(sep).join("/")
  if (!projectDocsPagePathIsValid(pagePath)) {
    return createResultError(op, "Documentation page path is empty or reserved (index.md).")
  }
  return createResult(pagePath)
}
