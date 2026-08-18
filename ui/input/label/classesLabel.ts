import { classesDisabledModifierPeer } from "#ui/classes/classesDisabledModifierPeer.js"
import { classArr } from "#ui/utils/classArr.js"

export const classesLabel = classArr(
  "font-medium leading-none", // font
  "whitespace-nowrap", // no text wrapping
  classesDisabledModifierPeer, // disabled
)
