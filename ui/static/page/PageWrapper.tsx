import { classesBgGray } from "#ui/classes/classesBg.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface PageWrapperProps extends MayHaveChildren, MayHaveClass {
  innerClass?: string
}

/** Full-height page container with centered inner content. */
export function PageWrapper(p: PageWrapperProps) {
  return (
    <div class={classMerge("min-h-dvh w-full", classesBgGray, p.class)}>
      <div class={classMerge("max-w-7xl mx-auto", "dark:text-white", "p-4", p.innerClass)}>{p.children}</div>
    </div>
  )
}
