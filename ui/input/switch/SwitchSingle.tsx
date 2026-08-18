import { Key } from "@solid-primitives/keyed"
import { ttt } from "#ui/i18n/ttt.js"
import { classArr } from "#ui/utils/classArr.js"
import type { SignalObject } from "#ui/utils/createSignalObject.js"
import type { HasGetOptions } from "#ui/utils/HasGetOptions.js"
import type { HasValueSignalString } from "#ui/utils/HasValueSignalString.js"
import type { MayHaveValueText } from "#ui/utils/HasValueText.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveDisabled } from "#ui/utils/MayHaveDisabled.js"
import type { MayHaveId } from "#ui/utils/MayHaveId.js"

/**
 * https://github.com/radix-ui/primitives/blob/main/packages/react/radio-group/src/Radio.tsx
 */
export interface SwitchSingleProps
  extends HasValueSignalString,
    HasGetOptions,
    MayHaveValueText,
    MayHaveId,
    MayHaveDisabled,
    MayHaveClass {
  texts?: SwitchSingleTexts
}

export type SwitchSingleTexts = {
  noEntries: string
}

/** Segmented radio-group switch selecting one value. */
export function SwitchSingle(p: SwitchSingleProps) {
  const filled = true
  const texts =
    p.texts ??
    ({
      noEntries: ttt("No entries"),
    } as const satisfies SwitchSingleTexts)

  return (
    <div
      id={p.id}
      role="radiogroup"
      data-disabled={p.disabled}
      class={classArr(
        "flex flex-wrap gap-2",
        // "grid gap-2 rounded-md p-2",
        filled && "bg-white dark:bg-black", // bg
        filled && "border border-slate-200 dark:border-slate-700", // border
        p.class,
      )}
    >
      <Key each={p.getOptions()} by={(item) => item} fallback={<NoItems texts={texts} />}>
        {(item) => (
          <Option
            item={item()}
            valueSignal={p.valueSignal}
            disabled={p.disabled}
            filled={filled}
            valueText={p.valueText}
          />
        )}
      </Key>
    </div>
  )
}

interface NoItemsProps extends MayHaveClass {
  texts: SwitchSingleTexts
}

function NoItems(p: NoItemsProps) {
  return <div class={p.class}>{p.texts.noEntries}</div>
}

interface Option2Props extends MayHaveClass {
  item: string
  valueSignal: SignalObject<string>
  filled: boolean
  valueText?: (value: string) => string
  disabled?: boolean
}

function Option(p: Option2Props) {
  return (
    <button
      type="button"
      role="radio"
      disabled={p.disabled}
      aria-checked={isChecked(p)}
      data-checked={isChecked(p)}
      data-state={isChecked(p) ? "checked" : "unchecked"}
      data-disabled={p.disabled}
      value={isChecked(p) ? "on" : "off"}
      class={classArr(
        "cursor-pointer select-none",
        "rounded-sm",
        "px-3 py-2 text-center",
        isChecked(p) ? "bg-blue-500 text-white" : "hover:bg-slate-50 dark:hover:bg-slate-900", // bg hover
        "flex gap-2",
        p.class,
      )}
      onClick={() => optionToggle(p)}
    >
      {getText(p)}
    </button>
  )
}

function optionToggle(p: Option2Props) {
  if (p.valueSignal.get() === p.item) return
  p.valueSignal.set(p.item)
}

function isChecked(p: Option2Props) {
  return p.item === p.valueSignal.get()
}

function getText(p: Option2Props): string {
  return p.valueText ? p.valueText(p.item) : p.item
}
