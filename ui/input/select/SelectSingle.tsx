import Popover from "@corvu/popover"
import { mdiCheck } from "@adaptive-ds/mdi/mdiCheck.js"
import { For, type JSX, Show } from "solid-js"
import type { SelectSingleEntry, SelectSingleGroupEntry } from "#ui/input/select/SelectSingleEntry.js"
import type { SelectSingleTexts } from "#ui/input/select/SelectSingleTexts.js"
import { selectSingleTextDefault } from "#ui/input/select/SelectSingleTexts.js"
import { ButtonIcon } from "#ui/interactive/button/ButtonIcon.jsx"
import { buttonVariant } from "#ui/interactive/button/buttonCva.js"
import type { CorvuPopoverProps } from "#ui/interactive/popover/CorvuPopover.jsx"
import { CorvuPopover } from "#ui/interactive/popover/CorvuPopover.jsx"
import { classesGridCols3xl } from "#ui/static/grid/classesGridCols.js"
import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"
import { createSignalObject, type SignalObject } from "#ui/utils/createSignalObject.js"
import type { HasValueSignalString } from "#ui/utils/HasValueSignalString.js"
import type { MayHaveValueText } from "#ui/utils/HasValueText.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveDisabled } from "#ui/utils/MayHaveDisabled.js"
import type { MayHaveId } from "#ui/utils/MayHaveId.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"

export interface SelectSingleProps
  extends HasValueSignalString,
    MayHaveId,
    MayHaveClass,
    MayHaveInnerClass,
    MayHaveChildren,
    MayHaveDisabled,
    MayHaveValueText {
  getOptions: () => SelectSingleEntry[]
  buttonProps: CorvuPopoverProps
  renderItem?: (value: string) => JSX.Element
  noItemsClass?: string
  listOptionClass?: string
  texts?: SelectSingleTexts
}

/** Popover select choosing one value, with optional inline group headings. */
export function SelectSingle(p: SelectSingleProps) {
  const texts = p.texts ?? selectSingleTextDefault
  const open = createSignalObject(p.buttonProps.open ?? false)

  function handleOpenChange(nextOpen: boolean): void {
    open.set(nextOpen)
    p.buttonProps.onOpenChange?.(nextOpen)
  }

  return (
    <div id={p.id} class={classArr("inline-flex", p.class)}>
      <CorvuPopover
        {...p.buttonProps}
        open={open.get()}
        onOpenChange={handleOpenChange}
        aria-haspopup="listbox"
        aria-label={getTriggerLabel(p, texts)}
        buttonChildren={
          <TriggerValue valueSignal={p.valueSignal} valueText={p.valueText} renderItem={p.renderItem} texts={texts} />
        }
        disabled={p.disabled}
      >
        <OptionList
          valueSignal={p.valueSignal}
          getOptions={p.getOptions}
          valueText={p.valueText}
          renderItem={p.renderItem}
          noItemsClass={p.noItemsClass}
          listOptionClass={p.listOptionClass}
          innerClass={p.innerClass}
          disabled={p.disabled}
          closePopover={() => handleOpenChange(false)}
          texts={texts}
        />
      </CorvuPopover>
    </div>
  )
}

interface TriggerValueProps extends MayHaveValueText {
  valueSignal: SignalObject<string>
  renderItem?: (value: string) => JSX.Element
  texts: SelectSingleTexts
}

function TriggerValue(p: TriggerValueProps) {
  return (
    <Show when={p.valueSignal.get()} keyed fallback={p.texts.selectEntry}>
      {(value) => (p.renderItem ? p.renderItem(value) : getDisplayValue(value, p.valueText))}
    </Show>
  )
}

interface OptionListProps extends MayHaveInnerClass, MayHaveDisabled, MayHaveValueText {
  valueSignal: SignalObject<string>
  getOptions: () => SelectSingleEntry[]
  renderItem?: (value: string) => JSX.Element
  noItemsClass?: string
  listOptionClass?: string
  texts: SelectSingleTexts
  closePopover: () => void
}

function OptionList(p: OptionListProps) {
  return (
    <div role="listbox" class={getInnerClass(p.getOptions().length, p.innerClass)}>
      <For each={p.getOptions()} fallback={<NoItems class={p.noItemsClass} texts={p.texts} />}>
        {(entry) => (
          <Entry
            entry={entry}
            valueSignal={p.valueSignal}
            valueText={p.valueText}
            renderItem={p.renderItem}
            listOptionClass={p.listOptionClass}
            disabled={p.disabled}
            closePopover={p.closePopover}
          />
        )}
      </For>
    </div>
  )
}

interface EntryProps extends MayHaveDisabled, MayHaveValueText {
  entry: SelectSingleEntry
  valueSignal: SignalObject<string>
  renderItem?: (value: string) => JSX.Element
  listOptionClass?: string
  closePopover: () => void
}

function Entry(p: EntryProps) {
  const item = () => (p.entry.type === "item" ? p.entry : undefined)

  return (
    <Show when={item()} fallback={<GroupHeading entry={p.entry} />}>
      {(item) => (
        <ListOption
          option={item().value}
          valueSignal={p.valueSignal}
          valueText={p.valueText}
          renderItem={p.renderItem}
          listOptionClass={p.listOptionClass}
          disabled={p.disabled}
          closePopover={p.closePopover}
        />
      )}
    </Show>
  )
}

interface GroupHeadingProps {
  entry: SelectSingleGroupEntry | SelectSingleEntry
}

function GroupHeading(p: GroupHeadingProps) {
  if (p.entry.type !== "group") return null

  return (
    <div role="presentation" class={classArr("px-3 pt-2 text-sm font-semibold", "text-muted-foreground")}>
      {p.entry.label}
    </div>
  )
}

interface ListOptionProps extends MayHaveDisabled, MayHaveValueText {
  option: string
  valueSignal: SignalObject<string>
  renderItem?: (value: string) => JSX.Element
  listOptionClass?: string
  closePopover: () => void
}

function ListOption(p: ListOptionProps) {
  const label = () => getDisplayValue(p.option, p.valueText)
  const isSelected = () => p.valueSignal.get() === p.option

  return (
    <Popover.Close
      as={ButtonIcon}
      role="option"
      aria-label={label()}
      aria-selected={isSelected()}
      iconRight={isSelected() ? mdiCheck : undefined}
      onKeyDown={(event) => handleOptionKeyDown(event, p.option, p.valueSignal, p.closePopover)}
      onClick={() => p.valueSignal.set(p.option)}
      variant={buttonVariant.ghost}
      class={classMerge("justify-start text-left", p.listOptionClass)}
      disabled={p.disabled}
    >
      {p.renderItem ? p.renderItem(p.option) : label()}
    </Popover.Close>
  )
}

interface NoItemsProps extends MayHaveClass {
  texts: SelectSingleTexts
}

function NoItems(p: NoItemsProps) {
  return <div class={classMerge("py-2 px-3", p.class)}>{p.texts.noEntries}</div>
}

function getTriggerLabel(p: SelectSingleProps, texts: SelectSingleTexts): string {
  const value = p.valueSignal.get()
  if (!value) return texts.selectEntry
  return getDisplayValue(value, p.valueText)
}

function getDisplayValue(value: string, valueText?: (value: string) => string): string {
  if (!valueText) return value
  return valueText(value) || value
}

function getInnerClass(optionAmount: number, innerClass?: string): string {
  if (innerClass) return innerClass
  if (optionAmount <= 0) return ""
  const base = " gap-x-2 gap-y-1"
  if (optionAmount <= 5) return `grid grid-cols-1${base}`
  if (optionAmount <= 9) return `grid grid-cols-2${base}`
  return classesGridCols3xl + base
}

function handleOptionKeyDown(
  event: KeyboardEvent,
  option: string,
  valueSignal: SignalObject<string>,
  closePopover: () => void,
): void {
  if (event.key === " ") {
    event.preventDefault()
    valueSignal.set(option)
    closePopover()
    return
  }

  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return

  const currentOption = event.currentTarget
  if (!(currentOption instanceof HTMLElement)) return

  const listbox = currentOption.closest('[role="listbox"]')
  if (!(listbox instanceof HTMLElement)) return

  const options = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'))
  const currentIndex = options.indexOf(currentOption)
  if (currentIndex < 0 || options.length === 0) return

  let nextIndex = currentIndex
  if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % options.length
  if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + options.length) % options.length
  if (event.key === "Home") nextIndex = 0
  if (event.key === "End") nextIndex = options.length - 1

  const nextOption = options[nextIndex]
  if (!nextOption) return

  event.preventDefault()
  nextOption.focus()
}
