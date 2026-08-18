import { isServer } from "solid-js/web"
import * as v from "valibot"
import { themeButtonTextDefault } from "#ui/interactive/theme/ThemeButtonText.js"
import {
  getThemeFromStorageOrBrowserPref,
  nextTheme2,
  setThemeToBrowser,
  type ThemeVariant,
  themeIcon,
  themeLocalStorageKey,
  themeSchema,
  themeVariant,
} from "#ui/interactive/theme/themeVariant.js"
import { toastAdd } from "#ui/interactive/toast/toastAdd.js"
import { toastVariant } from "#ui/interactive/toast/toastVariant.js"
import { createSignalObject } from "#ui/utils/createSignalObject.js"

export const themeSignal = createSignalObject<ThemeVariant>(themeVariant.os)

export function themeInit() {
  if (isServer) return // Skip during SSR
  const theme = getThemeFromStorageOrBrowserPref()
  themeSet(theme, false)
  themeRegisterStorageListener()
}

export function themeSet(theme: ThemeVariant, saveToStorage: boolean) {
  themeSignal.set(theme)
  setThemeToBrowser(theme)
  if (!saveToStorage) return
  localStorage.setItem(themeLocalStorageKey, theme)
}

function themeRegisterStorageListener() {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== themeLocalStorageKey) return
    const themeString = e.newValue
    const result = v.safeParse(themeSchema, themeString)
    if (!result.success) {
      console.log("failed to parse storage event")
      return
    }
    themeSet(result.output, false)
  }
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener("storage", onStorage)
  }
}

export function themeRotate() {
  const currentTheme = themeSignal.get()
  const newTheme = nextTheme2(currentTheme)

  const themeText = themeButtonTextDefault[newTheme]
  const title = themeButtonTextDefault.setTheme(themeText)
  const icon = themeIcon(newTheme)
  toastAdd({ title, icon, variant: toastVariant.default })
  themeSet(newTheme, true)
}
