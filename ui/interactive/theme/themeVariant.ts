import { mdiBrightnessAuto, mdiWeatherNight, mdiWhiteBalanceSunny } from "@mdi/js"
import * as v from "valibot"

export type ThemeVariant = keyof typeof themeVariant

export const themeVariant = {
  light: "light",
  dark: "dark",
  os: "os",
} as const

export const themeSchema = v.enum(themeVariant)

export const themeLocalStorageKey = "theme"

export function nextTheme3(current: string | undefined): ThemeVariant {
  switch (current) {
    case themeVariant.light:
      return themeVariant.dark
    case themeVariant.dark:
      return themeVariant.os
    case themeVariant.os:
      return themeVariant.light
    default:
      return themeVariant.dark
  }
}

export function nextTheme2(current: string | undefined): ThemeVariant {
  switch (current) {
    case themeVariant.light:
      return themeVariant.dark
    case themeVariant.dark:
      return themeVariant.light
    case themeVariant.os:
      return themeVariant.light
    default:
      return themeVariant.dark
  }
}

export function themeIcon(t: string | undefined) {
  switch (t) {
    case themeVariant.light:
      return mdiWhiteBalanceSunny
    case themeVariant.dark:
      return mdiWeatherNight
    default:
      return mdiBrightnessAuto // mdiWhiteBalanceAuto
  }
}

export function setThemeToBrowser(t: ThemeVariant) {
  switch (t) {
    case themeVariant.light:
      return setBrowserThemeLight()
    case themeVariant.dark:
      return setBrowserThemeDark()
    case themeVariant.os:
      return setBrowserThemeOs()
  }
}

function setBrowserThemeDark() {
  // console.log("setBrowserThemeDark")
  document.documentElement.classList.add("dark")
}

function setBrowserThemeLight() {
  // console.log("setBrowserThemeLight")
  document.documentElement.classList.remove("dark")
}

// 2023: 93% - https://caniuse.com/?search=prefers-color-scheme
function setBrowserThemeOs() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  if (prefersDark) setBrowserThemeDark()
  else setBrowserThemeLight()
}

export function getThemeFromBrowserPref() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  if (prefersDark) return themeVariant.dark
  return themeVariant.light
}

export function getThemeFromStorageOrBrowserPref(): ThemeVariant {
  const op = "getThemeFromStorageOrBrowserPref"
  if (typeof window === "undefined") {
    // console.log(op, "themeInit: window undefined")
    return getThemeFromBrowserPref()
  }
  const stored = localStorage?.getItem(themeLocalStorageKey) ?? null
  if (!stored) {
    // console.log(op, "!stored", stored)
    return getThemeFromBrowserPref()
  }
  const result = v.safeParse(themeSchema, stored)
  if (!result.success) {
    // console.log(op, "!parsed.success", result.issues, stored)
    return getThemeFromBrowserPref()
  }
  return result.output
}
