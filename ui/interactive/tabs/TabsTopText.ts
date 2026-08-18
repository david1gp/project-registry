import { ttt } from "#ui/i18n/ttt.js"

export type TabsTopText = {
  noEntries: string
}

export const tabsTopTextDefault = {
  noEntries: ttt("No entries"),
} as const satisfies TabsTopText
