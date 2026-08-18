import { readFile, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { findComponentFilesRecursive } from "./parts/findComponentFilesRecursive.js"
import { parseComponentExports } from "./parts/parseComponentExports.js"
import { type ComponentIndexEntry, renderUiIndexMarkdown } from "./parts/renderUiIndexMarkdown.js"

export async function generateIndexAgents(uiDirRelative: string, outputFileRelative: string) {
  const baseDir = process.cwd()
  const uiDirAbsolute = join(baseDir, uiDirRelative)
  const files = await findComponentFilesRecursive(uiDirAbsolute)

  const byCategory: Record<string, ComponentIndexEntry[]> = {}
  for (const file of files) {
    const content = await readFile(file, "utf-8")
    const exports = parseComponentExports(content)
    if (exports.length === 0) continue

    const relFromUi = relative(uiDirAbsolute, file)
    const category = relFromUi.split(sep)[0] ?? relFromUi
    const importPath = `#ui/${relFromUi
      .split(sep)
      .join("/")
      .replace(/\.tsx$/, ".jsx")}`
    for (const e of exports) {
      ;(byCategory[category] ??= []).push({ ...e, importPath })
    }
  }

  const markdown = renderUiIndexMarkdown(byCategory)
  await writeFile(join(baseDir, outputFileRelative), markdown, "utf-8")
}
