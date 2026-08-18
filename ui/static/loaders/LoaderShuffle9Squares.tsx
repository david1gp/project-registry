import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import styles from "./LoaderShuffle9Squares.module.css"

/**
 * Loading spinner that shuffles a 3x3 grid of squares.
 * https://dev.to/afif/adding-100-css-loaders-to-the-collection-of-500-css-loaders-2a3p
 */
export function LoaderShuffle9Squares(p: MayHaveClass) {
  return <div class={classMerge(p.class, styles.LoaderShuffle9Squares)} />
}
