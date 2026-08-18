import { mdiInformationOutline } from "@mdi/js"
import { ttt } from "#ui/i18n/ttt.js"
import { buttonSize, buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { CorvuPopover } from "#ui/interactive/popover/CorvuPopover.jsx"
import type { HasChildren } from "#ui/utils/HasChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface InfoPopoverProps extends MayHaveClass, HasChildren {}

/** Info icon button revealing a help popover. */
export function InfoPopover(p: InfoPopoverProps) {
  return (
    <CorvuPopover
      icon={mdiInformationOutline}
      iconClass="size-5 fill-gray-500"
      variant={buttonVariant.ghost}
      title={ttt("More Information")}
      size={buttonSize.minimal}
      class={p.class ?? "ml-2"}
    >
      {p.children}
    </CorvuPopover>
  )
}
