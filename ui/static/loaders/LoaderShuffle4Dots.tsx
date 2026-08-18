import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import styles from "./LoaderShuffle4Dots.module.css"

/**
 * Loading spinner that shuffles four dots.
 * https://dev.to/afif/adding-100-css-loaders-to-the-collection-of-500-css-loaders-2a3p
 */
export function LoaderShuffle4Dots(p: MayHaveClass) {
  return <div class={classMerge(p.class, styles.LoaderShuffle4Dots)} />
}
