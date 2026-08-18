import { ttt } from "#ui/i18n/ttt.js"

export type Table1DTexts = {
  noEntries: string
}

export const table1DTextDefault = {
  noEntries: ttt("No entries"),
} as const satisfies Table1DTexts
