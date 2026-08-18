import { ttt } from "#ui/i18n/ttt.js"

export type LabelAsterixTexts = {
  isRequired: string
}

export const labelAsterixTextDefault = {
  isRequired: ttt("Required field"),
} as const satisfies LabelAsterixTexts
