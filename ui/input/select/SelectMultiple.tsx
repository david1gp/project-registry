import { mdiCheck } from "@adaptive-ds/mdi/mdiCheck.js"
import { mdiClose } from "@adaptive-ds/mdi/mdiClose.js"
import { mdiPlus } from "@adaptive-ds/mdi/mdiPlus.js"
import { Key } from "@solid-primitives/keyed"
import { For, mergeProps } from "solid-js"
import type { SelectMultipleTexts } from "#ui/input/select/SelectMultipleTexts.js"
import { selectMultipleTextDefault } from "#ui/input/select/SelectMultipleTexts.js"
import { ButtonIcon } from "#ui/interactive/button/ButtonIcon.jsx"
import { buttonVariant } from "#ui/interactive/button/buttonCva.js"
import type { CorvuPopoverProps } from "#ui/interactive/popover/CorvuPopover.jsx"
import { CorvuPopover } from "#ui/interactive/popover/CorvuPopover.jsx"
import { classesGridCols3xl } from "#ui/static/grid/classesGridCols.js"
import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { SignalObject } from "#ui/utils/createSignalObject.js"
import type { HasGetOptions } from "#ui/utils/HasGetOptions.js"
import type { HasValueSignalStringArray } from "#ui/utils/HasValueSignalStringArray.js"
import type { MayHaveValueText } from "#ui/utils/HasValueText.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveDisabled } from "#ui/utils/MayHaveDisabled.js"
import type { MayHaveId } from "#ui/utils/MayHaveId.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"

/**
 * https://github.com/radix-ui/primitives/blob/main/packages/react/checkbox/src/Checkbox.tsx
 */
export interface SelectMultipleProps
  extends HasValueSignalStringArray,
    HasGetOptions,
    MayHaveValueText,
    MayHaveId,
    MayHaveClass,
    MayHaveInnerClass,
    MayHaveChildren,
    MayHaveDisabled {
  buttonProps: CorvuPopoverProps
  textNoEntries?: string
  textAddEntry?: string
  addEntryClass?: string
  noItemsClass?: string
  listOptionClass?: string
  texts?: SelectMultipleTexts
}

/** Popover multi-select showing chosen values as removable chips. */
export function SelectMultiple(p: SelectMultipleProps) {
  const texts = p.texts ?? selectMultipleTextDefault

  const buttonClass = classMerge(p.addEntryClass, p.buttonProps.class)
  const buttonProps = mergeProps(p.buttonProps, {
    icon: mdiPlus,
    children: p.textAddEntry ?? texts.addEntry,
    class: buttonClass,
    disabled: p.disabled,
  })
  return (
    <div
      id={p.id}
      class={classArr(
        "group border border-input",
        "px-2 py-2 text-sm",
        "ring-offset-background ",
        "rounded-md",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        "flex flex-col items-center justify-center gap-1", // layout
        p.class,
      )}
    >
      <SelectedValues valueSignal={p.valueSignal} valueText={p.valueText} noItemsClass={p.noItemsClass} texts={texts} />
      <CorvuPopover {...buttonProps}>
        <OptionList
          id={p.id}
          valueSignal={p.valueSignal}
          getOptions={p.getOptions}
          valueText={p.valueText}
          noItemsClass={p.noItemsClass}
          listOptionClass={p.listOptionClass}
          innerClass={p.innerClass}
          disabled={p.disabled}
          texts={texts}
        />
      </CorvuPopover>
    </div>
  )
}

interface SelectedValuesProps {
  valueSignal: SignalObject<string[]>
  valueText?: (value: string) => string
  noItemsClass?: string
  texts: SelectMultipleTexts
}

function SelectedValues(p: SelectedValuesProps) {
  return (
    <ul class={"flex flex-wrap gap-1 m-0 p-0 list-none"}>
      <Key each={p.valueSignal.get()} by={(item) => item} fallback={<NoItems class={p.noItemsClass} texts={p.texts} />}>
        {(item) => (
          <SelectedValue option={item()} valueSignal={p.valueSignal} valueText={p.valueText} texts={p.texts} />
        )}
      </Key>
    </ul>
  )
}

interface MultiselectOptionState {
  option: string
  valueSignal: SignalObject<string[]>
  valueText?: (value: string) => string
}

interface SelectedValueProps extends MultiselectOptionState {
  texts: SelectMultipleTexts
}

function SelectedValue(p: SelectedValueProps) {
  const label = () => (p.valueText ? p.valueText(p.option) : p.option)
  return (
    <li class="contents">
      <ButtonIcon
        variant={buttonVariant.filled}
        iconRight={mdiClose}
        class={"text-sm px-2 py-1"}
        data-value={p.option}
        onMouseDown={(_e) => optionRemove(p)}
        onClick={(_e) => optionRemove(p)}
        title={p.texts.removeX(label())}
      >
        {label()}
      </ButtonIcon>
    </li>
  )
}

interface OptionListProps
  extends HasValueSignalStringArray,
    HasGetOptions,
    MayHaveValueText,
    MayHaveId,
    MayHaveInnerClass,
    MayHaveDisabled {
  noItemsClass?: string
  listOptionClass?: string
  texts: SelectMultipleTexts
}

function OptionList(p: OptionListProps) {
  return (
    <div role="listbox" aria-multiselectable="true" class={getInnerClass(p.getOptions().length, p.innerClass)}>
      <For each={p.getOptions()} fallback={<NoItems class={p.noItemsClass} texts={p.texts} />}>
        {(option, index) => (
          <ListOption
            id={p.id}
            option={option}
            index={index()}
            valueSignal={p.valueSignal}
            valueText={p.valueText}
            listOptionClass={p.listOptionClass}
            disabled={p.disabled}
          />
        )}
      </For>
    </div>
  )
}

function getInnerClass(optionAmount: number, innerClass?: string): string {
  if (innerClass) return innerClass
  if (optionAmount <= 0) return ""
  const base = " gap-x-2 gap-y-1"
  if (optionAmount <= 5) return `grid grid-cols-1${base}`
  if (optionAmount <= 9) return `grid grid-cols-2${base}`
  if (optionAmount > 9) return classesGridCols3xl + base
  return ""
}

interface ListOptionProps extends MayHaveId, MultiselectOptionState, MayHaveDisabled {
  index: number
  listOptionClass?: string
}

function ListOption(p: ListOptionProps) {
  const label = () => (p.valueText ? p.valueText(p.option) : p.option)
  return (
    <ButtonIcon
      // id={`${p.id}-option-${p.index}`}
      role="option"
      aria-selected={optionIsSelected(p)}
      iconRight={optionIsSelected(p) ? mdiCheck : undefined}
      onClick={() => {
        toggleOption(p)
      }}
      variant={buttonVariant.ghost}
      class={classMerge("justify-start", p.listOptionClass)}
      disabled={p.disabled}
    >
      {label()}
    </ButtonIcon>
  )
}

function toggleOption(p: MultiselectOptionState) {
  const hasOption = optionIsSelected(p)
  if (hasOption) {
    return optionRemove(p)
  }
  return optionAdd(p)
}

function optionRemove(p: MultiselectOptionState) {
  const newValues = p.valueSignal.get().filter((v) => v !== p.option)
  p.valueSignal.set(newValues)
}

function optionAdd(p: MultiselectOptionState) {
  const newValues = [...p.valueSignal.get(), p.option]
  newValues.sort((a, b) => a.localeCompare(b))
  p.valueSignal.set(newValues)
}

function optionIsSelected(p: MultiselectOptionState) {
  return p.valueSignal.get().includes(p.option)
}

interface NoItemsProps extends MayHaveClass {
  texts?: SelectMultipleTexts
}

function NoItems(p: NoItemsProps) {
  return (
    <div
      class={classMerge(
        "py-2 px-3",
        // button
        "rounded-md ring-offset-background", // rounded, rings
        "border border-slate-200 dark:border-slate-700 dark:hover:bg-slate-900", // border
        p.class,
      )}
    >
      {p.texts?.noEntries ?? "No entries"}
    </div>
  )
}
