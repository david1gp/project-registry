import { createResult, type Result } from "#result"

export type ProjectFilterCriteria = {
  readonly section?: string
  readonly metadata?: Readonly<Record<string, string | undefined>>
}

type ProjectWithLabels = {
  readonly labels?: Readonly<Record<string, string>>
}

/**
 * Filter a list of projects or service rows by section and metadata/label criteria.
 *
 * Matching rules:
 * - section: case-insensitive, trimmed match against item.labels.section
 * - metadata: for each [key, expectedValue]:
 *   - if expectedValue is non-empty string: item.labels[key] === expectedValue
 *   - if expectedValue is empty string or undefined: key must exist in item.labels and be non-empty
 * All criteria are combined with AND logic.
 */
export function projectFilter<T extends ProjectWithLabels>(
  items: readonly T[],
  criteria: ProjectFilterCriteria,
): Result<T[]> {
  const op = "projectFilter"
  const normalizedSection = criteria.section?.trim().toLowerCase()
  const metadataEntries = Object.entries(criteria.metadata ?? {})

  const filtered = items.filter((item) => {
    const labels = item.labels ?? {}

    if (normalizedSection !== undefined && normalizedSection !== "") {
      const itemSection = labels.section?.trim().toLowerCase()
      if (itemSection !== normalizedSection) return false
    }

    for (const [key, expectedValue] of metadataEntries) {
      const actualValue = labels[key]
      if (actualValue === undefined || actualValue === "") return false
      if (expectedValue !== undefined && expectedValue !== "" && actualValue !== expectedValue) {
        return false
      }
    }

    return true
  })

  return createResult(filtered)
}
