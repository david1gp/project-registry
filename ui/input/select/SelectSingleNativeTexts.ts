import { ttt } from "#ui/i18n/ttt.js"

export type SelectSingleNativeTexts = {
  noEntries: string
}

export const selectSingleNativeTextDefault = {
  noEntries: ttt("No entries"),
} as const satisfies SelectSingleNativeTexts
