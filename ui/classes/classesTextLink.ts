import { classArr } from "#ui/utils/classArr.js"

export const classesTextLink = classArr(
  "text-blue-600 hover:text-indigo-800", // light
  "dark:text-blue-200 dark:hover:text-orange-200", // dark
  "transition-colors", // animation
)

export const classesTextLinkGroupHover = classArr(
  "group-hover:text-indigo-800", // light
  "dark:group-hover:text-orange-200", // dark
  "transition-colors", // animation
)
