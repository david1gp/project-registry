import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"

export type BadgeVariant = keyof typeof badgeVariant

export const badgeVariant = {
  // transparent bg
  subtle: "subtle",
  outline: "outline",
  // colors 1
  contrast: "contrast",
  // colors 2
  filledGreen: "filledGreen",
  filledYellow: "filledYellow",
  filledBlue: "filledBlue",
  filledRed: "filledRed",
} as const

const baseClasses = classArr(
  "inline-flex items-center", // layout
  "text-sm", // text
  "px-2.5 py-0.5 border rounded-full", // padding
  "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2", // focus ring
)

const variantClasses = {
  subtle: "bg-slate-100 text-slate-900 dark:bg-slate-700 dark:text-slate-100",
  outline: "text-foreground",
  contrast: "bg-slate-900 border-transparent text-white dark:bg-slate-50 dark:text-slate-900",
  filledGreen: "bg-green-500 text-white border-green-500",
  filledYellow: "bg-yellow-500 text-white border-yellow-500",
  filledBlue: "bg-sky-500 text-white border-sky-500",
  filledRed: "bg-red-600 text-white border-red-600 dark:border-red-600",
} as const satisfies Record<BadgeVariant, string>

const defaultVariant = badgeVariant.outline

export function badgeCva1(
  variant: BadgeVariant | null = defaultVariant,
  ...customClasses: (string | boolean | undefined | null | 0)[]
) {
  return classMerge(baseClasses, variantClasses[variant ?? defaultVariant], customClasses)
}
