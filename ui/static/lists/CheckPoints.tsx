import { mdiCheck } from "@adaptive-ds/mdi/mdiCheck.js"
import { For } from "solid-js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import { TextOrLink } from "./TextOrLink.js"

export interface CheckPointsProps extends MayHaveClass {
  points: string[] | Readonly<string[]>
  classText?: string
  classBullet?: string
}

/** List of text items with green checkmarks. */
export function CheckPoints(p: CheckPointsProps) {
  return (
    <For each={p.points}>
      {(point) => (
        <div class={classMerge("flex flex-row flex-nowrap", p.class)}>
          <Icon
            path={mdiCheck}
            class={classMerge("fill-green-600 dark:fill-green-600 mr-1 flex-none", p.classBullet)}
          />
          <TextOrLink text={point} class={p.classText} />
        </div>
      )}
    </For>
  )
}
