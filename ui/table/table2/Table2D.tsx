import { For } from "solid-js"
import type { DesktopTableClassNames } from "#ui/table/shared/DesktopTableClassNames.js"
import { sharedTableRowClassName } from "#ui/table/shared/sharedTableRowClassName.js"
import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"
import type { Table2Signals } from "#ui/table/table2/createSortableTableSignals.js"
import { sortData } from "#ui/table/table2/sortData.js"
import { nextSortDir } from "#ui/table/table2/sortDir.js"
import { Table2DSortButton } from "#ui/table/table2/Table2DSortButton.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface SortableTableDProps<T> extends Table2Signals<T>, MayHaveClass {
  desktopClasses?: DesktopTableClassNames
}

//
// table
//

/** Renders table2 sortable desktop full-table layout. */
export function Table2D<T>(p: SortableTableDProps<T>) {
  // const l = useAtomValue(languageAtom)
  // const columns = useAtomValue(atoms.columns)
  // const [data, setData] = useAtom(atoms.rows)
  // const [sortDir, setSortDir] = useAtom(atoms.sortDir)
  // const [prevHeader, setPrevHeader] = useAtom(atoms.prevHeader)

  function doSort(sortHeader: TableColumnDef<T>) {
    const nextSortDirState = nextSortDir(p.prevHeader.get(), sortHeader, p.sortDir.get())
    // console.log(prevHeader?.name, "->", sortHeader.name, sortDir, "->", nextSortDirState)
    p.sortDir.set(nextSortDirState)
    p.prevHeader.set(sortHeader)
    const sortedData = sortData<T>(p.rows.get(), sortHeader, p.sortDir.get())
    p.rows.set(sortedData)
  }

  return (
    <table class={classMerge("overflow-x-auto", p.class, p.desktopClasses?.class)}>
      <thead>
        <tr>
          <For each={p.columns.get()}>
            {(h) => (
              <th scope={"col"} class={classMerge("text-left", p.desktopClasses?.header, h.headerClass)}>
                <Table2DSortButton sortHeader={h} onClick={doSort} />
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={p.rows.get()}>
          {(d) => (
            <tr class={classMerge(sharedTableRowClassName, p.desktopClasses?.row)}>
              <For each={p.columns.get()}>
                {(h) => <td class={classMerge(p.desktopClasses?.data, h.dataClass)}>{h.cell(d)}</td>}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
