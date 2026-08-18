import { readdir } from "node:fs/promises"
import { join } from "node:path"

export async function findDemoFilesRecursive(path: string): Promise<string[]> {
  const allDemoFiles: string[] = []

  // Process the current directory
  const demoFilesInCurrentDir = await findDemoFilesInDir(path)
  allDemoFiles.push(...demoFilesInCurrentDir)

  // Get all entries in the current directory
  const entries = await readdir(path, { withFileTypes: true })

  // Process subdirectories recursively
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subDirPath = join(path, entry.name)
      const demoFilesInSubDir = await findDemoFilesRecursive(subDirPath)
      allDemoFiles.push(...demoFilesInSubDir)
    }
  }

  return allDemoFiles
}

export async function findDemoFilesInDir(path: string): Promise<string[]> {
  // const categoryPath = join(demosPath, category.name)
  const demoFiles = await readdir(path)
  const filtered = demoFiles
    .filter((file: string) => file.startsWith("Demo"))
    .filter((file: string) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .map((file: string) => `${path}/${file}`)
  // .map((file) => file.replace(/\.tsx$/, ""))
  return filtered
}
