import { classMerge } from "#ui/utils/classMerge.js"

export const classesPopoverContent = [
  "z-50", // positioning
  "max-w-4xl",
  "px-3 py-3", // spacing
  "rounded-lg", // border
  "dark:border", // border
  "bg-white dark:bg-black", // background
  "shadow-md", // shadow
  "data-open:animate-in data-open:fade-in-50% data-open:slide-in-from-top-1 data-closed:animate-out data-closed:fade-out-50% data-closed:slide-out-to-top-1", // animations
]

export function classesPopoverContentMerge(innerClass?: string) {
  return classMerge(classesPopoverContent, innerClass)
}
