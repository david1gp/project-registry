import { For } from "solid-js"
import { Separator } from "#ui/static/separator/Separator.jsx"
import type { MobileTableClassNames } from "#ui/table/shared/MobileTableClassNames.js"
import { Table1MEntry } from "#ui/table/table1/Table1MEntry.jsx"
import type { Table2Signals } from "#ui/table/table2/createSortableTableSignals.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface SortableTableMProps<T> extends Table2Signals<T>, MayHaveClass {
  mobileClasses?: MobileTableClassNames
}

/** Renders table2 sortable mobile stacked-card layout. */
export function Table2M<T>(p: SortableTableMProps<T>) {
  return (
    <div class={classMerge("flex flex-col flex-wrap w-full gap-4", p.class, p.mobileClasses?.class)}>
      <For each={p.rows.get()}>
        {(row, i) => (
          <>
            <Separator />
            <Table1MEntry row={row} columns={p.columns.get()} mobileClasses={p.mobileClasses} />
          </>
        )}
      </For>
    </div>
  )
}
