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

export interface CheckMultipleProps<T extends string>
  extends MayHaveId,
    MayHaveButtonVariant,
    MayHaveClass,
    MayHaveInnerClass,
    MayHaveDisabled {
  // state
  valueSignal: SignalObject<T[]>
  getOptions: () => T[]
  valueText?: (value: T) => string
  valueTextClass?: string
  valueTextSubtitle?: (value: T) => string | undefined
  valueTextSubtitleClass?: string
  // styling
  optionClass?: string
}

/** Checkbox group selecting multiple values from options. */
export function CheckMultiple<T extends string = string>(p: CheckMultipleProps<T>) {
  const [local, others] = splitProps(p, ["class"])
  return (
    <div
      id={p.id}
      class={classArr(
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
        optionClass={p.optionClass}
        innerClass={p.innerClass}
      />
    </div>
  )
}

function OptionList<T extends string = string>(p: CheckMultipleProps<T>) {
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
            disabled={p.disabled}
          />
        )}
      </For>
    </div>
  )
}

interface CheckOptionProps<T extends string> extends MayHaveButtonVariant, MayHaveDisabled, MayHaveInnerClass {
  option: T
  valueSignal: SignalObject<T[]>
  valueText?: (value: T) => string
  valueTextClass?: string
  valueTextSubtitle?: (value: T) => string | undefined
  valueTextSubtitleClass?: string
  optionClass?: string
}

function CheckOption<T extends string>(p: CheckOptionProps<T>) {
  const label = () => (p.valueText ? p.valueText(p.option) : p.option)
  const subtitle = () => (p.valueTextSubtitle ? p.valueTextSubtitle(p.option) : undefined)
  const isSelected = () => p.valueSignal.get().includes(p.option)

  return (
    <ButtonIcon
      role="option"
      aria-selected={isSelected()}
      icon={isSelected() ? mdiCheckboxMarkedCircle : mdiCheckboxBlankCircleOutline}
      // iconRight={isSelected() ? mdiCheckboxMarkedCircle : mdiCheckboxBlankCircleOutline}
      onClick={() => toggleOption(p)}
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

function innerClass(optionAmount: number, innerClass?: string): string {
  if (innerClass) return innerClass
  if (optionAmount <= 0) return ""
  const base = "gap-x-2 gap-y-1"
  if (optionAmount <= 5) return classArr("grid grid-cols-1", base)
  if (optionAmount <= 9) return classArr("grid grid-cols-2", base)
  return classArr(classesGridCols3xl, base)
}

function toggleOption<T extends string>(p: CheckOptionProps<T>) {
  const hasOption = p.valueSignal.get().includes(p.option)
  if (hasOption) {
    optionRemove(p)
  } else {
    optionAdd(p)
  }
}

function optionRemove<T extends string>(p: CheckOptionProps<T>) {
  const newValues = p.valueSignal.get().filter((v) => v !== p.option)
  p.valueSignal.set(newValues)
}

function optionAdd<T extends string>(p: CheckOptionProps<T>) {
  const newValues = [...p.valueSignal.get(), p.option]
  newValues.sort((a, b) => a.localeCompare(b))
  p.valueSignal.set(newValues)
}
