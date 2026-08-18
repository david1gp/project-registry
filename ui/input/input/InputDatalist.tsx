import { type ComponentProps, splitProps } from "solid-js"
import { Input } from "#ui/input/input/Input.jsx"
import type { HasId } from "#ui/utils/HasId.js"
import type { MayHaveClassAndChildren } from "#ui/utils/MayHaveClassAndChildren.js"
import { generateId12 } from "#utils/ran/generateId12.js"

export interface ResourceListSearchProps extends ComponentProps<"input"> {
  getOptions: () => string[]
  optionDisplayText?: (option: string) => string
}

/** Text input with autocomplete suggestions from a datalist. */
export function InputDatalist(p: ResourceListSearchProps) {
  const [s, rest] = splitProps(p, ["id", "class", "type", "list"])
  const id = p.id ?? generateId12()
  const listId = id + "-options"

  return (
    <>
      <Input id={id} type={s.type ?? "text"} class={p.class} list={listId} {...rest} />
      <DataList id={listId} getOptions={p.getOptions} optionDisplayText={p.optionDisplayText} />
    </>
  )
}

import { Key } from "@solid-primitives/keyed"

interface DataListProps extends HasId, MayHaveClassAndChildren {
  getOptions: () => string[]
  optionDisplayText?: (option: string) => string
}

function DataList(p: DataListProps) {
  return (
    <datalist id={p.id}>
      <Key each={p.getOptions()} by={(i) => i}>
        {(item) => <option value={item()}>{p.optionDisplayText ? p.optionDisplayText(item()) : item()}</option>}
      </Key>
    </datalist>
  )
}
