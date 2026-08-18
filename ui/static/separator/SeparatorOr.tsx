import { ttt } from "#ui/i18n/ttt.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import { SeparatorWithText } from "./SeparatorWithText.js"

/** Horizontal divider with a centered "Or" label. */
export function SeparatorOr(p: MayHaveClass) {
  return (
    <SeparatorWithText class={p.class}>
      <p class={"mx-4 mb-0 text-center font-semibold"}>{ttt("Or")}</p>
    </SeparatorWithText>
  )
}
