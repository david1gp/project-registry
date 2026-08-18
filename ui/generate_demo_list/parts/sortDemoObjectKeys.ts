export function sortDemoObjectKeys<T = any>(given: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(given).sort(([a], [b]) => a.localeCompare(b)))
}
