import { ttt1 } from "#ui/i18n/ttt.js"

export type NumberInputText = {
  decreaseByX: (amount: number) => string
  increaseByX: (amount: number) => string
}

export const numberInputTextDefault = {
  decreaseByX: (amount: number) => ttt1("Decrease by [X]", amount.toString()),
  increaseByX: (amount: number) => ttt1("Increase by [X]", amount.toString()),
} as const satisfies NumberInputText
