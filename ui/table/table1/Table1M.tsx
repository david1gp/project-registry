import { Separator } from "#ui/static/separator/Separator.jsx"
import type { MobileTableClassNames } from "#ui/table/shared/MobileTableClassNames.js"
import type { Table1Data } from "#ui/table/table1/Table1Data.js"
import { Table1MEntry } from "#ui/table/table1/Table1MEntry.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface Table1aMProps<T> extends Table1Data<T>, MayHaveClass {
  mobileClasses?: MobileTableClassNames
}

/** Renders table1 mobile stacked-card layout. */
export function Table1M<T>(p: Table1aMProps<T>) {
  return (
    <div class={classMerge("flex flex-col flex-wrap w-full gap-4", p.class, p.mobileClasses?.class)}>
      {p.rows.map((row, y) => (
        <>
          <Separator />
          <Table1MEntry row={row} columns={p.columns} mobileClasses={p.mobileClasses} />
        </>
      ))}
    </div>
  )
}
