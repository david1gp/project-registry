import { Key } from "@solid-primitives/keyed"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import type { SelectSingleNativeTexts } from "#ui/input/select/SelectSingleNativeTexts.js"
import { selectSingleNativeTextDefault } from "#ui/input/select/SelectSingleNativeTexts.js"
import { classArr } from "#ui/utils/classArr.js"
import type { HasGetOptions } from "#ui/utils/HasGetOptions.js"
import type { HasValueSignalString } from "#ui/utils/HasValueSignalString.js"
import type { MayHaveValueText } from "#ui/utils/HasValueText.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveDisabled } from "#ui/utils/MayHaveDisabled.js"
import type { MayHaveId } from "#ui/utils/MayHaveId.js"

export type StringStringFn = (value: string) => string

export interface SelectSingleNativeProps
  extends HasValueSignalString,
    HasGetOptions,
    MayHaveValueText,
    MayHaveClass,
    MayHaveId,
    MayHaveChildren,
    MayHaveDisabled {
  texts?: SelectSingleNativeTexts
}

/** Native dropdown selecting a single signal-bound value. */
export function SelectSingleNative(p: SelectSingleNativeProps) {
  const texts = p.texts ?? selectSingleNativeTextDefault

  return (
    <select
      id={p.id}
      class={classArr(
        "block w-full p-2.5",
        "text-gray-900 dark:text-white", // text
        "placeholder:text-muted-foreground", // text placeholder
        "bg-gray-50 dark:bg-gray-700", // bg
        "rounded-lg border border-gray-300 dark:border-gray-500", // border
        "focus:ring-blue-500 focus:border-blue-500 dark:focus:border-blue-500 dark:focus:ring-blue-500",
        p.disabled && classesDisabledDirectly,
        p.class,
      )}
      value={p.valueSignal.get()}
      onChange={(e) => onChange(e, p)}
      disabled={p.disabled}
    >
      <Key each={p.getOptions()} by={(item) => item} fallback={<NoItems texts={texts} />}>
        {(getItem) => <SelectItem itemValue={getItem()} valueText={p.valueText} />}
      </Key>
    </select>
  )
}

function onChange(
  e: Event & {
    currentTarget: HTMLSelectElement
    target: HTMLSelectElement
  },
  p: SelectSingleNativeProps,
): void {
  p.valueSignal.set(e.currentTarget.value)
}

interface NoItemsProps extends MayHaveClass {
  texts: SelectSingleNativeTexts
}

function NoItems(p: NoItemsProps) {
  return <div class={p.class}>{p.texts.noEntries}</div>
}

interface SelectItemProps extends MayHaveClass {
  itemValue: string
  valueText?: StringStringFn
}

function SelectItem(p: SelectItemProps) {
  return (
    <option value={p.itemValue} class={p.class}>
      {getDisplayValue(p.itemValue, p.valueText)}
    </option>
  )
}

function getDisplayValue(itemValue: string, valueText?: StringStringFn) {
  if (!valueText) return itemValue
  const hasValue = valueText(itemValue)
  if (!hasValue) return itemValue
  return hasValue
}
