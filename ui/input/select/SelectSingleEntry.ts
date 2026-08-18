export type SelectSingleItemEntry = {
  type: "item"
  value: string
}

export type SelectSingleGroupEntry = {
  type: "group"
  label: string
}

export type SelectSingleEntry = SelectSingleItemEntry | SelectSingleGroupEntry
