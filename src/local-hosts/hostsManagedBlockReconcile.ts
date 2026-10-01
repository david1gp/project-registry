import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { createResult, createResultError, type Result } from "#result"
import { hostsManagedBlockRender } from "./hostsManagedBlockRender.js"

const startMarker = "# BEGIN project-registry managed hosts"
const endMarker = "# END project-registry managed hosts"

/** Replace only the marked registry block at an explicit output path. */
export async function hostsManagedBlockReconcile(
  outputPath: string,
  domains: readonly string[],
): Promise<Result<void>> {
  const op = "hostsManagedBlockReconcile"
  if (outputPath.trim() === "") return createResultError(op, "An output path is required.")
  const rendered = hostsManagedBlockRender(domains)
  if (!rendered.success) return rendered

  let existing: string
  try {
    existing = await readFile(outputPath, "utf8")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return createResultError(op, `Could not read output file: ${String(error)}`)
    }
    existing = ""
  }

  const starts = [...existing.matchAll(/^# BEGIN project-registry managed hosts\s*$/gm)]
  const ends = [...existing.matchAll(/^# END project-registry managed hosts\s*$/gm)]
  if (starts.length !== ends.length || starts.length > 1) {
    return createResultError(op, "Existing managed hosts markers are malformed or duplicated.")
  }

  let output: string
  if (starts.length === 1) {
    const start = starts[0]
    const end = ends[0]
    if (start === undefined || end === undefined || start.index === undefined || end.index === undefined || end.index < start.index) {
      return createResultError(op, "Existing managed hosts markers are malformed.")
    }
    const endAfterLine = existing.indexOf("\n", end.index)
    output = `${existing.slice(0, start.index)}${rendered.data}${existing.slice(endAfterLine < 0 ? existing.length : endAfterLine + 1)}`
  } else {
    output = `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${
      existing.length > 0 ? "\n" : ""
    }${rendered.data}`
  }

  try {
    if (output === existing) {
      await chmod(outputPath, 0o644)
      return createResult(undefined)
    }
    const tempPath = join(dirname(outputPath), `.project-registry-hosts-${randomUUID()}.tmp`)
    try {
      await writeFile(tempPath, output, { encoding: "utf8", mode: 0o644, flag: "wx" })
      await chmod(tempPath, 0o644)
      await rename(tempPath, outputPath)
    } catch (error) {
      try {
        await unlink(tempPath)
      } catch {}
      throw error
    }
    return createResult(undefined)
  } catch (error) {
    return createResultError(op, `Could not atomically write output file: ${String(error)}`)
  }
}
