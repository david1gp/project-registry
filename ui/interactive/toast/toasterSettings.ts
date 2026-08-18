import { isDevEnv } from "#ui/env/isDevEnv.js"

export const toasterSettings = {
  toastLimit: 3,
  removeDelayMs: isDevEnv() ? 5000 : 7000,
} as const
