import { mdiCheckCircleOutline } from "@mdi/js"
import { Show } from "solid-js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classesPageWrapper } from "#ui/static/page/classesPageWrapper.js"
import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"

export interface SuccessPageProps extends MayHaveClass, MayHaveInnerClass, MayHaveChildren {
  title: string
  subtitle?: string
  icon?: string
  iconClass?: string
  titleClass?: string
  subtitleClass?: string
}

const classesPageWrapperInner = classArr(
  "max-w-md w-full", // sizing
  "bg-white dark:bg-gray-800", // background
  "rounded-lg shadow-md", // styling
  "p-8", // spacing
)

/** Centered success page with icon, title, and subtitle. */
export function SuccessPage(p: SuccessPageProps) {
  return (
    <div class={classMerge(classesPageWrapper, p.class)}>
      <div class={classMerge(classesPageWrapperInner, p.innerClass)}>
        <Show when={p.icon}>
          <Icon
            path={p.icon ?? mdiCheckCircleOutline}
            class={classMerge(
              "w-16 h-16", // sizing
              "mx-auto", // positioning
              "fill-green-500",
              p.iconClass,
            )}
          />
        </Show>
        <h1
          class={classMerge(
            "text-2xl font-bold", // typography
            "text-gray-800 dark:text-white", // text color
            "mt-4", // spacing
            "text-center", // text
            p.titleClass,
          )}
        >
          {p.title}
        </h1>
        <Show when={p.subtitle}>
          <p
            class={classMerge(
              "text-gray-600 dark:text-gray-300", // text color
              "mt-2", // spacing
              "text-center", // text
              p.subtitleClass,
            )}
          >
            {p.subtitle}
          </p>
        </Show>
        {p.children}
      </div>
    </div>
  )
}
