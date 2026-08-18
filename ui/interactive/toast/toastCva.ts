import { type ToastVariant, toastVariant } from "#ui/interactive/toast/toastVariant.js"
import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"

const baseClasses = classArr(
  "rounded-lg shadow-lg", // card shadows/padding
  "p-4",
)

const variantClasses = {
  // filled grayscale
  filled: classArr(
    "dark:text-slate-100", // text
    "bg-white dark:bg-black", // bg
    "hover:bg-slate-50 dark:hover:bg-slate-900", // bg hover
    "border border-slate-200 dark:border-slate-700", // border
  ),
  subtle: classArr(
    "text-slate-900 dark:text-slate-100", // text
    "bg-slate-100 hover:bg-slate-200 dark:bg-slate-700", // bg
  ),
  default: classArr(
    "text-white dark:text-slate-900 dark:hover:text-slate-900", // text
    "bg-slate-900 dark:bg-slate-50", // bg
    "hover:bg-slate-700 dark:hover:bg-slate-300", // bg hover
  ),
  // filled colors
  primary: "bg-indigo-500 text-white hover:bg-indigo-700 dark:bg-slate-800 dark:border-slate-700",
  // filled colors status
  success: "bg-green-500 text-white border-green-500",
  error: "bg-red-600 text-white border-red-600 dark:border-red-600",
  info: "bg-sky-500 text-white border-sky-500",
  warning: "bg-yellow-500 text-white border-yellow-500",
} as const satisfies Record<ToastVariant, string>

const defaultVariant = toastVariant.default

export function toastCva(
  variant: ToastVariant | null = defaultVariant,
  ...customClasses: (string | boolean | undefined | null | 0)[]
) {
  return classMerge(baseClasses, variantClasses[variant ?? defaultVariant], customClasses)
}
