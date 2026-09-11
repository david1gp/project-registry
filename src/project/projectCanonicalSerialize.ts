import { createResult, type Result } from "#result"
import { projectMigrate } from "./projectMigrate.js"

export function projectCanonicalSerialize(input: unknown): Result<string> {
  const migrated = projectMigrate(input)
  if (!migrated.success) return migrated
  return createResult(`${JSON.stringify(migrated.data, null, 2)}\n`)
}
