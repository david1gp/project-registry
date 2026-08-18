import { splitProps } from "solid-js"
import type { DesktopTableClassNames } from "#ui/table/shared/DesktopTableClassNames.js"
import type { MobileTableClassNames } from "#ui/table/shared/MobileTableClassNames.js"
import { tableVisibilityClasses } from "#ui/table/shared/tableVisibilityClasses.js"
import type { Table2Signals } from "#ui/table/table2/createSortableTableSignals.js"
import { Table2D } from "#ui/table/table2/Table2D.jsx"
import { Table2M } from "#ui/table/table2/Table2M.jsx"
import { type TailwindBreakpoint, tailwindBreakpoint } from "#ui/utils/tailwindBreakpoint.js"

export interface Table2RProps<T> extends Table2Signals<T> {
  breakpoint?: TailwindBreakpoint
  desktopClasses?: DesktopTableClassNames
  mobileClasses?: MobileTableClassNames
}

/** Responsive sortable table2 switching desktop and mobile by breakpoint. */
export function Table2R<T>(p: Table2RProps<T>) {
  const [, desktopP] = splitProps(p, ["breakpoint", "mobileClasses"])
  const [, mobileP] = splitProps(p, ["breakpoint", "desktopClasses"])
  return (
    <>
      <Table2D<T> {...desktopP} class={tableVisibilityClasses.desktop(p.breakpoint ?? tailwindBreakpoint.sm)} />
      <Table2M<T> {...mobileP} class={tableVisibilityClasses.mobile(p.breakpoint ?? tailwindBreakpoint.sm)} />
    </>
  )
}
