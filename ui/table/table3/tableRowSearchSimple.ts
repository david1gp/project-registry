import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"

export function tableRowSearchSimple<T>(allRows: T[], searchInput: string, columns: TableColumnDef<T>[]): T[] {
  const lowerSearchInput = searchInput.toLowerCase()
  const found: T[] = []
  for (const row of allRows) {
    for (const column of columns) {
      const dataFn = column.data
      if (!dataFn) continue
      const gotValue = dataFn(row)
      const valueAsString = gotValue.toString().toLowerCase()
      if (valueAsString.includes(lowerSearchInput)) {
        found.push(row)
        break
      }
    }
  }
  return found
}

export type TableRowSearchDataExtractionFn<T> = (data: T) => string | number

export function tableRowSearchSimpleDirectly<T>(
  allRows: T[],
  searchInput: string,
  dataExtraction: TableRowSearchDataExtractionFn<T>[],
): T[] {
  const lowerSearchInput = searchInput.toLowerCase()
  const found: T[] = []
  for (const row of allRows) {
    for (const dataFn of dataExtraction) {
      const data = dataFn(row)
      if (!data) continue
      const valueAsString = data.toString().toLowerCase()
      if (valueAsString.includes(lowerSearchInput)) {
        found.push(row)
        break
      }
    }
  }
  return found
}
