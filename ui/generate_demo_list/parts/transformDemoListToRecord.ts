export function transformDemoListToRecord(given: Record<string, string[]>): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}

  for (const [key, filePaths] of Object.entries(given)) {
    const componentMap: Record<string, string> = {}

    for (const filePath of filePaths) {
      // Extract the filename from the path
      const filename = filePath.split("/").pop()
      if (!filename) continue

      // Remove the .tsx extension
      const componentName = filename.replace(/\.tsx?$/, "")

      // Map the component name to itself
      componentMap[componentName] = componentName
    }

    result[key] = componentMap
  }

  return result
}
