export type FilterableTableRowKey<T> = {
  getRowKey: (row: T) => string
}
