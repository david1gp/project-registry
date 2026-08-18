import { ttt, ttt1 } from "#ui/i18n/ttt.js"

export type ThemeButtonText = {
  light: string
  dark: string
  os: string
  currentTheme: (theme: string) => string
  setTheme: (theme: string) => string
}

export const themeButtonTextDefault = {
  light: ttt("Light"),
  dark: ttt("Dark"),
  os: ttt("Operation system"),
  currentTheme: (theme: string) => ttt1("Current theme: [X]", theme),
  setTheme: (theme: string) => ttt1("Theme set: [X]", theme),
} as const satisfies ThemeButtonText
