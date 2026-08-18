import { mdiAlertBoxOutline } from "@mdi/js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { HasTitle } from "#ui/utils/HasTitle.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveIcon } from "#ui/utils/MayHaveIcon.js"
import type { MayHaveSubtitle } from "#ui/utils/MayHaveSubtitle.js"

export interface ErrorPageProps extends HasTitle, MayHaveSubtitle, MayHaveIcon, MayHaveClass, MayHaveChildren {}

/** Centered error page with icon, title, and subtitle. */
export function ErrorPage(p: ErrorPageProps) {
  return (
    <div
      class={classMerge(
        "flex flex-row items-center justify-center", // layout
        "my-25",
        // "min-h-[80dvh]", // sizing
        p.class,
      )}
    >
      <div
        class={classMerge(
          "max-w-md w-full", // sizing
          "bg-white dark:bg-gray-800", // bg
          "rounded-lg shadow-md", // styling
          "p-8 text-center", // spacing + typography
        )}
      >
        <Icon
          path={p.icon ?? mdiAlertBoxOutline}
          class={classMerge(
            "w-16 h-16 mx-auto", // sizing + layout
            "fill-red-500", // color
            p.iconClass,
          )}
        />
        <h1
          class={classMerge(
            "text-2xl font-bold", // typography
            "text-gray-800 dark:text-white", // color
            "mt-4", // spacing
            p.titleClass,
          )}
        >
          {p.title}
        </h1>
        {p.subtitle && (
          <p
            class={classMerge(
              "text-gray-600 dark:text-gray-300", // color
              "mt-2", // spacing
              p.subtitleClass,
            )}
          >
            {p.subtitle}
          </p>
        )}
        {p.children}
      </div>
    </div>
  )
}
