import { ttt } from "#ui/i18n/ttt.js"

export type CorcuDialogTexts = {
  closeDialog: string
}

export const corvuDialogTextDefault = {
  closeDialog: ttt("Close dialog"),
} as const satisfies CorcuDialogTexts
