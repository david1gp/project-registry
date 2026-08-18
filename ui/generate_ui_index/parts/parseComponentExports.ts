export interface ParsedComponentExport {
  name: string
  description: string | null
}

const exportRe = /^export (?:const|function) ([A-Z]\w*)/

// Collect every PascalCase value export in a file, pairing each with the
// one-line description from a JSDoc block directly above it (if present).
export function parseComponentExports(fileContent: string): ParsedComponentExport[] {
  const lines = fileContent.split("\n")
  const exports: ParsedComponentExport[] = []
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i]?.match(exportRe)?.[1]
    if (!name) continue
    exports.push({ name, description: jsdocDescriptionAbove(lines, i) })
  }
  return exports
}

function jsdocDescriptionAbove(lines: string[], exportIndex: number): string | null {
  const lineAt = (i: number) => lines[i]?.trim() ?? ""
  let end = exportIndex - 1
  while (end >= 0 && lineAt(end) === "") end--
  if (end < 0 || !lineAt(end).endsWith("*/")) return null
  let start = end
  while (start >= 0 && !lineAt(start).startsWith("/**")) start--
  if (start < 0) return null
  const content = lines
    .slice(start, end + 1)
    .map((line) =>
      line
        .trim()
        .replace(/^\/\*\*+/, "")
        .replace(/\*\/$/, "")
        .replace(/^\*\s?/, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.startsWith("@"))

  // Use the first JSDoc line only. It must be a short prose summary, so reject
  // a leading URL or a single-token label (e.g. a bare reference comment).
  const summary = content[0]
  if (!summary || /https?:\/\//.test(summary)) return null
  if (summary.split(/\s+/).length < 2) return null
  return summary
}
