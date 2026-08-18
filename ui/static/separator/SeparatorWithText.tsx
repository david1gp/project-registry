import { classArr } from "#ui/utils/classArr.js"
import type { MayHaveChildrenAndClass } from "#ui/utils/MayHaveChildrenAndClass.js"

/** Horizontal divider flanking centered children content. */
export function SeparatorWithText(p: MayHaveChildrenAndClass) {
  return (
    <div class={classArr("w-full flex flex-row items-center")}>
      <Line />
      {p.children}
      <Line />
    </div>
  )
}

function Line() {
  return <div class="flex-1 h-0.5 bg-gray-400 dark:bg-gray-600 mx-4" />
}
