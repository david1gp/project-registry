import { ttt } from "#ui/i18n/ttt.js"

export type SelectSingleTexts = {
  selectEntry: string
  noEntries: string
}

export const selectSingleTextDefault = {
  selectEntry: ttt("Select entry"),
  noEntries: ttt("No entries"),
} as const satisfies SelectSingleTexts
