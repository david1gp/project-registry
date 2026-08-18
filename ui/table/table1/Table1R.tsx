import type { DesktopTableClassNames } from "#ui/table/shared/DesktopTableClassNames.js"
import type { MobileTableClassNames } from "#ui/table/shared/MobileTableClassNames.js"
import { tableVisibilityClasses } from "#ui/table/shared/tableVisibilityClasses.js"
import { Table1D } from "#ui/table/table1/Table1D.jsx"
import type { Table1Data } from "#ui/table/table1/Table1Data.js"
import { Table1M } from "#ui/table/table1/Table1M.jsx"
import type { TailwindBreakpoint } from "#ui/utils/tailwindBreakpoint.js"
import { tailwindBreakpoint } from "#ui/utils/tailwindBreakpoint.js"

export interface SortableTable1RProps<T> extends Table1Data<T> {
  breakpoint?: TailwindBreakpoint
  desktopClasses?: DesktopTableClassNames
  mobileClasses?: MobileTableClassNames
}

/** Responsive table1 switching desktop and mobile by breakpoint. */
export function Table1R<T>(p: SortableTable1RProps<T>) {
  return (
    <>
      <Table1D
        rows={p.rows}
        columns={p.columns}
        class={tableVisibilityClasses.desktop(p.breakpoint ?? tailwindBreakpoint.sm)}
        desktopClasses={p.desktopClasses}
      />
      <Table1M
        rows={p.rows}
        columns={p.columns}
        class={tableVisibilityClasses.mobile(p.breakpoint ?? tailwindBreakpoint.sm)}
        mobileClasses={p.mobileClasses}
      />
    </>
  )
}
