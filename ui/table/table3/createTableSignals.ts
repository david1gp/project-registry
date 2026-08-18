import type { Accessor } from "solid-js"
import { searchInputSignal } from "#ui/input/search/searchInputSignal.js"
import { createTableColumnDef, type TableColumnDef, tableFilterColumns } from "#ui/table/shared/TableColumnDef.js"
import { sortData } from "#ui/table/table2/sortData.js"
import { defaultSortDir, type SortDir, sortDir } from "#ui/table/table2/sortDir.js"
import { defaultEntriesPerPage } from "#ui/table/table3/defaultEntriesPerPage.js"
import { tableRowSearchSimple } from "#ui/table/table3/tableRowSearchSimple.js"
import { createSignalObject, type SignalObject } from "#ui/utils/createSignalObject.js"

export type CreateTableAtoms<T> = {
  columns: TableColumnDef<T>[] | SignalObject<TableColumnDef<T>[]>
  columnFilter: string[] | SignalObject<string[]>
  rows: T[] | SignalObject<T[]>
  rowFilterColumnKeys: string[]
  entriesPerPage?: number
  getCsvFilenameAtom?: Accessor<string>
}

export function createTableAtoms<T>(props: CreateTableAtoms<T>): FilterableTableAtoms<T> {
  const state = createTableAtomsState(props)
  return createTableAtomsComputed(state)
}

export type TableAtomState<T> = {
  // input
  columnDefs: SignalObject<TableColumnDef<T>[]>
  columnFilter: SignalObject<string[]>
  rows: SignalObject<T[]>
  rowFilterColumnKeys: string[]
  // internal state
  entriesPerPage: number
  sortDir: SignalObject<SortDir>
  sortColumn: SignalObject<TableColumnDef<T>>
  currentPage: SignalObject<number>
  prevSearchInput: SignalObject<string>
  getCsvFilename: Accessor<string>
}

export interface FilterableTableAtoms<T> extends TableAtomState<T> {
  columnsFiltered: Accessor<TableColumnDef<T>[]>
  columnsFilteredAmount: Accessor<number>
  rowsFiltered: Accessor<T[]>
  rowsFilteredSortedPaged: Accessor<T[]>
  getRowAmountTotal: Accessor<number>
  getRowAmountFiltered: Accessor<number>
  hasRows: Accessor<boolean>
  // transferDebouncedInput: WritableAtom<null, [], void>
  sortHeaderClickAction: (sortHeader: TableColumnDef<T>) => void
  incrementPage: () => void
  decrementPage: () => void
  // csv
  getCsvContent: Accessor<string>
}

const log = false

//
// state
//

function createTableAtomsState<T>({
  columns,
  columnFilter,
  rows,
  // rowFilter,
  rowFilterColumnKeys,
  entriesPerPage,
  getCsvFilenameAtom,
}: CreateTableAtoms<T>): TableAtomState<T> {
  return {
    // input
    columnDefs: Array.isArray(columns) ? createSignalObject(columns) : columns,
    columnFilter: createColumnFilter(columnFilter),
    rows: Array.isArray(rows) ? createSignalObject(rows) : rows,
    // rowFilter: createStringAtom(rowFilter),
    // rowFilterInput: createStringAtom(rowFilter),
    rowFilterColumnKeys: rowFilterColumnKeys,
    // internal state
    entriesPerPage: entriesPerPage ?? defaultEntriesPerPage,
    sortDir: createSignalObject<SortDir>(defaultSortDir),
    sortColumn: createSignalObject(createTableColumnDef<T>()),
    currentPage: createSignalObject(0),
    prevSearchInput: createSignalObject(""),
    getCsvFilename: getCsvFilenameAtom ? getCsvFilenameAtom : () => new Date().toISOString(),
  }
}

function createColumnFilter(f: string[] | SignalObject<string[]>): SignalObject<string[]> {
  if (Array.isArray(f)) return createSignalObject<string[]>(f)
  return f
}

//
// computed state
//

function createTableAtomsComputed<T>(state: TableAtomState<T>): FilterableTableAtoms<T> {
  //
  // columns
  //
  const columnsFiltered = () => {
    const columns = state.columnDefs.get()
    const columnFilter = state.columnFilter.get()
    return tableFilterColumns(columns, columnFilter)
  }
  const columnsFilteredAmount = () => {
    return columnsFiltered().length
  }
  //
  // rows
  //
  const rowsFiltered = () => {
    const rows = state.rows.get()
    const rowFilter = searchInputSignal.get()

    if (log) console.log("rowsFiltered", rows)
    if (rowFilter.length <= 0) {
      return rows
    }
    const columns = state.columnDefs.get()
    return tableRowSearchSimple(rows, rowFilter, columns)
  }
  const rowsFilteredSorted = () => {
    const rows = rowsFiltered()
    const sortColumn = state.sortColumn.get()
    if (!sortColumn) {
      if (log) console.log("rowsFilteredSorted", "!sortColumn", rows)
      return rows
    }
    const sortDir = state.sortDir.get()
    const sortedRows = sortData<T>(rows, sortColumn, sortDir)
    if (log) console.log("rowsFilteredSorted", sortedRows)
    return sortedRows
  }
  const rowsFilteredSortedPaged = () => {
    const rows = rowsFilteredSorted()
    const currentPage = state.currentPage.get()
    return getPagedRows(rows, state, currentPage)
  }
  const getRowAmountFiltered = () => {
    const rows = rowsFiltered()
    return rows.length
  }
  const getRowAmountTotal = () => {
    const rows = state.rows.get()
    return rows.length
  }
  const hasRows = () => {
    return getRowAmountTotal() >= 1
  }
  //
  // actions
  //
  const sortHeaderClickAction = (sortColumn: TableColumnDef<T>) => {
    const prevHeader = state.sortColumn.get()
    const sortDir = state.sortDir.get()
    const nextSortDirState = nextSortDir(prevHeader, sortColumn, sortDir)
    // console.log(prevHeader?.name, "->", sortColumn.name, sortDir, "->", nextSortDirState)
    state.sortDir.set(nextSortDirState)
    state.sortColumn.set(sortColumn)
  }
  const decrementPage = () => {
    const currentPage = state.currentPage.get()
    const next = Math.max(0, currentPage - 1)
    // console.log(currentPage, "->", next)
    if (next === currentPage) return
    state.currentPage.set(next)
  }
  const incrementPage = () => {
    const currentPage = state.currentPage.get()
    const entries = getRowAmountFiltered()
    const maxPage = Math.floor(entries / state.entriesPerPage)
    const next = Math.min(maxPage, currentPage + 1)
    // console.log(currentPage, "->", next, "details:", { entries, maxPage })
    if (next === currentPage) return
    state.currentPage.set(next)
  }
  //
  // csv
  //
  const getCsvContent = () => {
    const rows = rowsFilteredSorted()
    const columns = columnsFiltered()
    const header = columns.map((c) => c.name ?? c.title ?? c.id).join(";")
    const csv = rows.map((r) => columns.map((c) => (c.data ? c.data(r) : "")).join(";")).join("\n")
    return "#" + header + "\n" + csv
  }
  return {
    ...state,
    // computed state
    columnsFiltered,
    columnsFilteredAmount,
    rowsFiltered,
    rowsFilteredSortedPaged,
    getRowAmountTotal,
    getRowAmountFiltered,
    hasRows,
    // transferDebouncedInput,
    sortHeaderClickAction,
    decrementPage,
    incrementPage,
    // csv
    getCsvContent,
  }
}

//
// header click
//

function nextSortDir<T>(
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

//
// paging
//

function getPagedRows<T>(rows: T[], state: TableAtomState<T>, currentPage: number) {
  const entries = rows.length
  const maxEntriesPerPage = state.entriesPerPage
  if (entries <= maxEntriesPerPage) return rows
  const from = currentPage * maxEntriesPerPage
  const to = Math.min((currentPage + 1) * maxEntriesPerPage, entries)
  // console.log(currentPage, from, to, entries)

  return rows.filter((r, i) => i >= from && i < to)
}
