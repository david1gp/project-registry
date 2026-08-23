import { mdiCircle } from "@adaptive-ds/mdi/mdiCircle.js"
import { For } from "solid-js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import { TextOrLink } from "./TextOrLink.js"

export interface BlackBulletPointsProps extends MayHaveClass {
  points: string[] | Readonly<string[]>
  classText?: string
  classBullet?: string
}

/** List of text items with black bullets. */
export function BlackBulletPoints(p: BlackBulletPointsProps) {
  return (
    <For each={p.points}>
      {(point) => (
        <div class={classMerge("flex gap-1", p.class)}>
          <Icon path={mdiCircle} class={classMerge("size-1.5 mt-2.5 shrink-0", p.classBullet)} />
          <TextOrLink text={point} class={p.classText} />
        </div>
      )}
    </For>
  )
}
