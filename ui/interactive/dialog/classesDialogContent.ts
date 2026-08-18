import { classMerge } from "#ui/utils/classMerge.js"

export const classesDialogContent = [
  "z-50", // positioning
  "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2", // centering
  // "w-full max-w-lg", // sizing
  "max-h-[95vh]", // max height to allow scrolling
  "overflow-auto", // enable scrolling when content overflows
  "p-6", // spacing
  "bg-white dark:bg-gray-900", // background
  "border border-gray-200 dark:border-gray-700", // border
  "rounded-lg shadow-lg", // border/shadow
  "data-open:animate-in data-open:fade-in-50% data-open:zoom-in-95% data-closed:animate-out data-closed:fade-out-50% data-closed:zoom-out-95%", // animations
]

export const classesDialogOverlay = [
  "fixed inset-0", // positioning
  "z-40", // positioning
  "bg-black/50", // background
  "data-open:animate-in data-open:fade-in-50% data-closed:animate-out data-closed:fade-out-50%", // animations
]

export function classesDialogContentMerge(innerClass?: string) {
  return classMerge(classesDialogContent, innerClass)
}

export function classesDialogOverlayMerge(innerClass?: string) {
  return classMerge(classesDialogOverlay, innerClass)
}
