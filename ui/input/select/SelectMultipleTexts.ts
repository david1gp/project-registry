import { ttt, ttt1 } from "#ui/i18n/ttt.js"

export type SelectMultipleTexts = {
  removeX: (x: string) => string
  addEntry: string
  noEntries: string
}

export const selectMultipleTextDefault = {
  removeX: (x: string) => ttt1("Remove [X]", x),
  addEntry: ttt("Add entry"),
  noEntries: ttt("No entries"),
} as const satisfies SelectMultipleTexts
