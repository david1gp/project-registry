import { mdiArrowDown, mdiArrowUp } from "@mdi/js"
import { ButtonIcon } from "#ui/interactive/button/ButtonIcon.jsx"
import { buttonVariant } from "#ui/interactive/button/buttonCva.js"
import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"
import { type SortDir, sortDir } from "#ui/table/table2/sortDir.js"
import { classMerge } from "#ui/utils/classMerge.js"

export interface Table2DSortButtonProps<T> {
  sortHeader: TableColumnDef<T>
  onClick: (sortDir: TableColumnDef<T>) => void
}

/** Table2 desktop column header sort button. */
export function Table2DSortButton<T>(p: Table2DSortButtonProps<T>) {
  return (
    <ButtonIcon
      variant={buttonVariant.ghost}
      onClick={() => p.onClick(p.sortHeader)}
      class={classMerge("w-full justify-start py-2 pl-1 pr-3 rounded-sm", p.sortHeader.headerClass)}
      iconClass={"size-5"}
      // iconRight={sortIcon(h, prevHeader, sortDir)}
      title={p.sortHeader.title}
    >
      {p.sortHeader.name}
    </ButtonIcon>
  )
}

function sortIcon<T>(
  sortHeader: TableColumnDef<T>,
  prevHeader: TableColumnDef<T> | null,
  dir: SortDir,
): string | undefined {
  if (!prevHeader || sortHeader.name !== prevHeader.name) return undefined
  if (dir === sortDir.asc) return mdiArrowUp
  if (dir === sortDir.des) return mdiArrowDown
  return undefined
}
