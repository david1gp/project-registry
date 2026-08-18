import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"
import { type SortDir, sortDir } from "#ui/table/table2/sortDir.js"

export function sortData<T>(data: T[], sortHeader: TableColumnDef<T>, dir: SortDir) {
  const sorted: T[] = [...data]
  sorted.sort((d1, d2) => {
    const s1 = sortHeader.data ? sortHeader.data(d1) : ""
    const s2 = sortHeader.data ? sortHeader.data(d2) : ""
    // numeric comparison
    if (typeof s1 === "number" && typeof s2 === "number") {
      const c = s1 - s2
      if (dir === sortDir.asc) return c
      return -c
    }
    // string comparison
    const c = s1.toString().localeCompare(s2.toString(), "en", { numeric: true })
    if (dir === sortDir.asc) return c
    return -c
  })
  // console.log("prev:", data,"sorted:", sorted)
  return sorted
}
