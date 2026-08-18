import type { JSXElement } from "solid-js"

export type TableColumnDef<T> = {
  id: string
  name: string
  title?: string
  data?: (data: T) => string | number
  cell: (data: T) => JSXElement
  headerClass?: string
  dataClass?: string
}

export function createTableColumnDef<T>(): TableColumnDef<T> {
  return {
    id: "",
    name: "",
    cell: (d: T) => "",
  }
}

//
// filter data & headers
//
export function tableFilterColumns<T>(columns: TableColumnDef<T>[], columnFilter: string[] | null | undefined) {
  if (!columnFilter) return columns
  return columns.filter((h) => columnFilter.includes(h.id))
}
export function tableFilterRows<T>(rows: T[], columns: TableColumnDef<T>[], filter: string | null | undefined) {
  if (!filter) return rows
  const result = rows.filter((d) => tableFilterRow(d, columns, filter))
  // console.log("result", result)
  return result
}
function tableFilterRow<T>(row: T, columns: TableColumnDef<T>[], filter: string) {
  const found = columns.find((h) => (h.data ? tableFilterRowValue(h.data(row), filter) : false))
  // console.log(row, "found:", found)
  return found !== undefined
}
function tableFilterRowValue(row: string | number, filter: string) {
  // return row.toString().toLowerCase().includes(filter.toLowerCase())
  const m = row.toString().toLowerCase().includes(filter.toLowerCase())
  // console.log(row, filter, "->", m)
  return m
}
