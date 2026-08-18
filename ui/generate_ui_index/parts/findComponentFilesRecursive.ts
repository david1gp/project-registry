import { readdir } from "node:fs/promises"
import { join } from "node:path"

// Directories under ui/ that hold infra/generators rather than reusable components.
const skipDirs = new Set(["generate_demo_list", "generate_ui_index", "demo_pages"])

export async function findComponentFilesRecursive(path: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      found.push(...(await findComponentFilesRecursive(entryPath)))
      continue
    }
    // Components are .tsx; Demo* files are exercised separately via the demo list.
    if (!entry.name.endsWith(".tsx")) continue
    if (entry.name.startsWith("Demo")) continue
    found.push(entryPath)
  }
  return found
}
