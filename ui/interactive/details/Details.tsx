import { mdiChevronDown } from "@adaptive-ds/mdi/mdiChevronDown.js"
import { type JSXElement, Show } from "solid-js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveIcon } from "#ui/utils/MayHaveIcon.js"
import type { MayHaveSubtitle } from "#ui/utils/MayHaveSubtitle.js"
import type { MayHaveTitle } from "#ui/utils/MayHaveTitle.js"

export interface DetailsProps extends MayHaveClass, MayHaveIcon, MayHaveTitle, MayHaveSubtitle, MayHaveChildren {
  summaryClass?: string
  summaryEl?: JSXElement
}

/** Collapsible disclosure panel with title and chevron. */
export function Details(p: DetailsProps) {
  return (
    <details
      class={classMerge(
        "group",
        "bg-white dark:bg-gray-800",
        "rounded-lg border border-gray-200",
        "shadow-sm",
        "overflow-hidden",
        p.class,
      )}
    >
      <summary
        class={classMerge(
          "flex flex-col sm:flex-row items-center justify-between",
          "p-6",
          "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors",
          p.summaryClass,
        )}
      >
        <Show when={!p.summaryEl && p.title}>
          <div class={"flex flex-col sm:flex-row gap-4"}>
            <Show when={p.icon}>
              <Icon path={p.icon!} class="size-7 mt-1" />
            </Show>
            <span>
              <h3 class={"text-xl font-semibold"}>{p.title}</h3>
              <Show when={p.subtitle}>
                <span class={"text-muted-foreground mt-1"}>{p.subtitle}</span>
              </Show>
            </span>
          </div>
        </Show>
        <Show when={p.summaryEl}>{p.summaryEl}</Show>
        <Icon
          path={mdiChevronDown}
          class={classArr("size-7", "text-gray-400 dark:text-gray-600", "transition-transform group-open:rotate-180")}
        />
      </summary>
      {p.children}
    </details>
  )
}
