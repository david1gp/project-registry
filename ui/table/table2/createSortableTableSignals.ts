import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"
import { type SortDir, sortDir } from "#ui/table/table2/sortDir.js"
import { createSignalObject, type SignalObject } from "#ui/utils/createSignalObject.js"

export type Table2Signals<T> = {
  rows: SignalObject<T[]>
  columns: SignalObject<TableColumnDef<T>[]>
  sortDir: SignalObject<SortDir>
  prevHeader: SignalObject<TableColumnDef<T> | null>
}

export function createSortableTableSignals1<T>(rows: T[], columns: TableColumnDef<T>[]): Table2Signals<T> {
  return createTable2Signals({
    rows: createSignalObject(rows),
    columns: createSignalObject(columns),
  })
}

export function createSortableTableSignals2<T>(
  rowsAtom: SignalObject<T[]>,
  columns: TableColumnDef<T>[],
): Table2Signals<T> {
  return createTable2Signals({
    rows: rowsAtom,
    columns: createSignalObject(columns),
  })
}

export type CreateTable2Props<T> = Omit<Table2Signals<T>, "sortDir" | "prevHeader">

export function createTable2Signals<T>(props: CreateTable2Props<T>): Table2Signals<T> {
  return {
    ...props,
    sortDir: createSignalObject<SortDir>(sortDir.asc),
    prevHeader: createSignalObject<TableColumnDef<T> | null>(null),
  }
}
