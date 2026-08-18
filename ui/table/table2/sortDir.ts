import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"

export type SortDir = keyof typeof sortDir
export const sortDir = {
  asc: "asc",
  des: "des",
} as const

export const sortDirValues = Object.values(sortDir)
export const defaultSortDir = sortDir.des

export function nextSortDir<T>(
  prevColumn: TableColumnDef<T> | null,
  sortColumn: TableColumnDef<T>,
  sortDir: SortDir,
): SortDir {
  if (!prevColumn) return defaultSortDir
  if (prevColumn.name === sortColumn.name) return iterateSortDir(sortDir)
  return defaultSortDir
}

function iterateSortDir(d: SortDir): SortDir {
  switch (d) {
    case sortDir.des:
      return sortDir.asc
    case sortDir.asc:
      return sortDir.des
  }
}
