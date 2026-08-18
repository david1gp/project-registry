import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"

export type Table1Data<T> = {
  rows: T[]
  columns: TableColumnDef<T>[]
}
