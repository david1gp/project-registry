import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import styles from "./LoaderSpin4Square.module.css"

/**
 * Loading spinner with four squares rotating in a ring.
 * https://dev.to/afif/i-made-100-css-loaders-for-your-next-project-4eje
 */
export function LoaderSpin4Square(p: MayHaveClass) {
  return <div class={classMerge(p.class, styles.LoaderSpin4Square)} />
}
