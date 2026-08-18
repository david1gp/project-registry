import { mdiCheckboxBlankCircleOutline, mdiCheckboxMarkedCircle } from "@mdi/js"
import { For, Show, splitProps } from "solid-js"
import { classesTextMuted } from "#ui/classes/classesTextMuted.js"
import { ButtonIcon } from "#ui/interactive/button/ButtonIcon.jsx"
import { buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { classesGridCols3xl } from "#ui/static/grid/classesGridCols.js"
import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { SignalObject } from "#ui/utils/createSignalObject.js"
import type { MayHaveButtonVariant } from "#ui/utils/MayHaveButtonVariant.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveDisabled } from "#ui/utils/MayHaveDisabled.js"
import type { MayHaveId } from "#ui/utils/MayHaveId.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"

export interface CheckSingleProps<T extends string>
  extends MayHaveId,
    MayHaveButtonVariant,
    MayHaveClass,
    MayHaveInnerClass,
    MayHaveDisabled {
  // state
  valueSignal: SignalObject<T>
  getOptions: () => T[]
  valueText?: (value: T) => string
  valueTextClass?: string
  valueTextSubtitle?: (value: T) => string | undefined
  valueTextSubtitleClass?: string
  // behavior
  disallowDeselection?: boolean
  // styling
  optionClass?: string
}

/** Radio-style group selecting a single value from options. */
export function CheckSingle<T extends string = string>(p: CheckSingleProps<T>) {
  const [local, others] = splitProps(p, ["class"])
  return (
    <div
      id={p.id}
      class={classMerge(
        "group border border-input",
        "px-2 py-2",
        "ring-offset-background",
        "rounded-md",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        "flex flex-col justify-center gap-1", // layout
        local.class,
      )}
    >
      <OptionList
        {...others}
        valueSignal={p.valueSignal}
        getOptions={p.getOptions}
        valueText={p.valueText}
        valueTextClass={p.valueTextClass}
        valueTextSubtitle={p.valueTextSubtitle}
        valueTextSubtitleClass={p.valueTextSubtitleClass}
        variant={p.variant}
        disallowDeselection={p.disallowDeselection}
        optionClass={p.optionClass}
        innerClass={p.innerClass}
      />
    </div>
  )
}

interface OptionListProps<T extends string> extends MayHaveButtonVariant, MayHaveDisabled, MayHaveInnerClass {
  valueSignal: SignalObject<T>
  getOptions: () => T[]
  valueText?: (value: T) => string
  valueTextClass?: string
  valueTextSubtitle?: (value: T) => string | undefined
  valueTextSubtitleClass?: string
  disallowDeselection?: boolean
  optionClass?: string
}

function OptionList<T extends string>(p: OptionListProps<T>) {
  return (
    <div class={innerClass(p.getOptions().length, p.innerClass)}>
      <For each={p.getOptions()}>
        {(option) => (
          <CheckOption
            option={option}
            valueSignal={p.valueSignal}
            valueText={p.valueText}
            valueTextClass={p.valueTextClass}
            valueTextSubtitle={p.valueTextSubtitle}
            valueTextSubtitleClass={p.valueTextSubtitleClass}
            optionClass={p.optionClass}
            variant={p.variant}
            disallowDeselection={p.disallowDeselection}
            disabled={p.disabled}
          />
        )}
      </For>
    </div>
  )
}

function innerClass(optionAmount: number, innerClass?: string): string {
  if (innerClass) return innerClass
  if (optionAmount <= 0) return ""
  const base = "gap-x-2 gap-y-1"
  if (optionAmount === 1) return classArr("grid grid-cols-1", base)
  if (optionAmount === 2) return classArr("grid grid-cols-2", base)
  return classArr(classesGridCols3xl, base)
}

interface CheckOptionProps<T extends string> extends MayHaveButtonVariant, MayHaveDisabled {
  option: T
  valueSignal: SignalObject<T>
  valueText?: (value: T) => string
  valueTextClass?: string
  valueTextSubtitle?: (value: T) => string | undefined
  valueTextSubtitleClass?: string
  disallowDeselection?: boolean
  optionClass?: string
}

function CheckOption<T extends string>(p: CheckOptionProps<T>) {
  const label = () => (p.valueText ? p.valueText(p.option) : p.option)
  const subtitle = () => (p.valueTextSubtitle ? p.valueTextSubtitle(p.option) : undefined)
  const isSelected = () => p.valueSignal.get() === p.option

  return (
    <ButtonIcon
      role="option"
      aria-selected={isSelected()}
      icon={isSelected() ? mdiCheckboxMarkedCircle : mdiCheckboxBlankCircleOutline}
      // iconRight={isSelected() ? mdiCheckboxMarkedCircle : mdiCheckboxBlankCircleOutline}
      onClick={() => toggleOption(p, p.disallowDeselection)}
      variant={p.variant ?? buttonVariant.filled}
      class={classMerge("justify-start text-left", p.optionClass)}
      disabled={p.disabled}
    >
      <span class="flex flex-col items-start">
        <span class={p.valueTextClass}>{label()}</span>
        <Show when={subtitle()}>
          {(subtitle) => <span class={classMerge(classesTextMuted, p.valueTextSubtitleClass)}>{subtitle()}</span>}
        </Show>
      </span>
    </ButtonIcon>
  )
}

function toggleOption<T extends string>(p: CheckOptionProps<T>, disallowDeselection?: boolean) {
  const isSelected = p.valueSignal.get() === p.option
  if (isSelected && !disallowDeselection) {
    p.valueSignal.set("" as T)
  } else {
    p.valueSignal.set(p.option)
  }
}
