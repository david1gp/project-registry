import Dialog from "@corvu/dialog"
import { mdiChevronDown, mdiClose } from "@mdi/js"
import { createSignal, type JSXElement, onMount, Show } from "solid-js"
import { buttonCvaIconOnly, buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import type { CorcuDialogTexts } from "#ui/interactive/dialog/CorcuDialogTexts.js"
import { corvuDialogTextDefault } from "#ui/interactive/dialog/CorcuDialogTexts.js"
import { classesDialogContentMerge, classesDialogOverlayMerge } from "#ui/interactive/dialog/classesDialogContent.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface DetailsDialogProps extends MayHaveClass {
  title: string
  /** Custom summary face; falls back to the title as an `<h3>`. Thunk so each render branch gets its own nodes. */
  summaryEl?: () => JSXElement
  summaryClass?: string
  /** Extra classes for the modal content panel. */
  innerClass?: string
  texts?: CorcuDialogTexts
  /**
   * Disclosure body. Rendered in the `<details>` fallback (for SSR / crawlers /
   * no-JS) and again in the modal, so it must be a thunk that returns a fresh
   * subtree per call.
   */
  content: () => JSXElement
}

const detailsClasses = [
  "group",
  "bg-white dark:bg-gray-800",
  "rounded-lg border border-gray-200",
  "shadow-sm",
  "overflow-hidden",
]
const summaryClasses = ["flex items-center justify-between gap-4", "p-6", "cursor-pointer", "text-left", "w-full"]

/**
 * SEO-friendly disclosure that upgrades to a modal.
 *
 * The body is server-rendered inside a native `<details>`, so it is in the static
 * HTML for crawlers and expands inline for users without JS — unlike a Corvu/Portal
 * dialog, whose content never reaches the server HTML (`solid-js/web`'s server
 * `Portal` renders nothing). Once JS mounts, the `<details>` is swapped for a Corvu
 * modal (focus trap, scroll lock, escape) opened by an equivalent trigger button.
 */
export function DetailsDialog(p: DetailsDialogProps) {
  const texts = p.texts ?? corvuDialogTextDefault
  const [enhanced, setEnhanced] = createSignal(false)
  onMount(() => setEnhanced(true))

  const face = () => (
    <>
      {p.summaryEl ? p.summaryEl() : <h3 class="text-xl font-semibold">{p.title}</h3>}
      <Icon
        path={mdiChevronDown}
        class="size-7 text-gray-400 transition-transform group-open:rotate-180 group-data-open:rotate-180 dark:text-gray-600"
      />
    </>
  )

  return (
    <Show
      when={enhanced()}
      fallback={
        <details class={classMerge(detailsClasses, p.class)}>
          <summary
            class={classMerge(
              summaryClasses,
              "hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors",
              p.summaryClass,
            )}
          >
            {face()}
          </summary>
          <div class="p-6 border-t border-gray-200 dark:border-gray-700">{p.content()}</div>
        </details>
      }
    >
      <Dialog>
        <Dialog.Trigger
          class={classMerge(
            "group",
            detailsClasses,
            summaryClasses,
            "hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors",
            p.summaryClass,
            p.class,
          )}
          aria-haspopup="dialog"
        >
          {face()}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay class={classesDialogOverlayMerge()} />
          <Dialog.Content class={classesDialogContentMerge(p.innerClass)}>
            <header class="flex items-center justify-between gap-2 mb-4">
              <Dialog.Label class="text-lg font-semibold">{p.title}</Dialog.Label>
              <Dialog.Close class={buttonCvaIconOnly(buttonVariant.outline, false, false)} title={texts.closeDialog}>
                <Icon path={mdiClose} class={buttonIconCva(buttonVariant.outline, "")} />
              </Dialog.Close>
            </header>
            {p.content()}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </Show>
  )
}
