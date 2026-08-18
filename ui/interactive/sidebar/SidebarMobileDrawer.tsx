import { splitProps } from "solid-js"
import { CorvuDialog, type CorvuDialogProps } from "#ui/interactive/dialog/CorvuDialog.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { SignalObject } from "#ui/utils/createSignalObject.js"

export interface SidebarMobileDrawerProps extends Omit<CorvuDialogProps, "open" | "onOpenChange"> {
  open: SignalObject<boolean>
}

/** Mobile sidebar rendered as a dialog drawer. */
export function SidebarMobileDrawer(p: SidebarMobileDrawerProps) {
  const [s, rest] = splitProps(p, ["open", "class"])
  return (
    <CorvuDialog
      {...rest}
      open={s.open.get()}
      onOpenChange={(open) => s.open.set(open)}
      class={classMerge("hidden", s.class)}
    />
  )
}
