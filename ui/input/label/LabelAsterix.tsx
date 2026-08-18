import { type LabelAsterixTexts, labelAsterixTextDefault } from "#ui/input/label/LabelAsterixTexts.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface LabelAsterixProps extends MayHaveClass {
  texts?: LabelAsterixTexts
}

/** Required-field asterisk marker for labels. */
export function LabelAsterix(p: LabelAsterixProps) {
  const texts = p.texts ?? labelAsterixTextDefault
  return (
    <span class={classMerge("text-primary", p.class)} title={texts.isRequired}>
      {" *"}
    </span>
  )
}
