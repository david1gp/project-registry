import { ttt, ttt1 } from "#ui/i18n/ttt.js"

export type LoadingPageTexts = {
  loading: (item?: string) => string
}

export const loadingPageTextsDefault = {
  loading: (item?: string) => (item ? ttt1("Loading [X]...", item) : ttt("Loading...")),
} as const satisfies LoadingPageTexts
